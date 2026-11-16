/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
/**
 * 03-storage — SQLite 底座（kind: impl，deps: ['core','project']）
 *
 * 干什么：打开/关闭 node:sqlite 的库、上 WAL 基线 PRAGMA、BUSY 重试、
 *        损坏回退（删三件重开一次）、孤儿 WAL 清理。
 * 为什么这样：移植 ref/current-engine/db-base.js 的**思路**，不整份拷 ——
 *            它带 Bun/better-sqlite3 三条后路；新引擎跑在宿主自带的 node ≥22.5
 *            上，只要 `node:sqlite` 一条路，三条后路全是死代码（01-立项书 §4.1-03）。
 *            两个必须留的真知：
 *            ① node:sqlite 的构造器**静默忽略** {timeout}（#642），busy_timeout
 *               必须走 PRAGMA 才生效，否则首次写冲突立刻 SQLITE_BUSY；
 *            ② Windows 崩溃残留的 -wal/-shm 会让"新建库"报 file is not a
 *               database（#244 一脉），开库前先清孤儿文件。
 * 边界：不建表、不迁移（04）；不做查询/写入（08/09）。S-3 本轮不调
 *      page_size/mmap_size/cache —— 立项书写明"本轮不调"，这里就一行都不加。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { err } from '../../libs/err.js';
import { createLogger } from '../../libs/log.js';

export const NAME = 'storage';

const l = createLogger().forScope(NAME);

/** 打开时写死 busy_timeout（毫秒）。#642：构造器 options 对 node:sqlite 无效。 */
const BUSY_TIMEOUT_MS = 30000;

/** SQLITE_BUSY 的判定串（照 1.2.2 withRetry 的两个形态，一个不加一个不减）。 */
const BUSY_MARKS = ['SQLITE_BUSY', 'database is locked'];

/** 损坏判定串（照 1.2.2 isSQLiteCorruptionError；SQLITE_CORRUPT/NOTADB/两种文案）。 */
const CORRUPT_MARKS = ['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'database disk image is malformed', 'file is not a database'];

/**
 * S-3 PRAGMA 基线：WAL + NORMAL + busy_timeout；autocheckpoint 保持默认(1000)，
 * page_size/mmap_size/cache **本轮不调**（01-立项书 §7.1 S-3 原话）。
 * 注意：node:sqlite 没有 .pragma() 方法（实测 typeof db.pragma === undefined），
 * 一切走 db.exec('PRAGMA …')；读值走 prepare('PRAGMA x').get()。
 */
function applyPragmas(db) {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
}

/** 从抛出物里取 message（Error/字符串/怪东西都兜）。 */
function msgOf(e) {
    return e instanceof Error ? e.message : String(e);
}

/** 错误文本是否属于"库损坏"这一类。 */
export function isCorruption(msg) {
    const s = String(msg);
    return CORRUPT_MARKS.some((m) => s.includes(m));
}

/** 错误文本是否属于 SQLITE_BUSY / 锁竞争这一类。 */
export function isBusy(msg) {
    const s = String(msg);
    return BUSY_MARKS.some((m) => s.includes(m));
}

/**
 * 主库不存在时删掉 -wal/-shm 孤儿文件（Windows 崩溃残留会毒化新建库）。
 * 主库存在时**一个都不动**：那是活库的组成部分。
 *
 * @param {string} dbPath
 * @returns {string[]} 实际删掉的文件（selftest 用）
 */
export function cleanOrphanedWAL(dbPath) {
    const removed = [];
    if (existsSync(dbPath)) return removed;
    for (const suffix of ['-wal', '-shm']) {
        const p = dbPath + suffix;
        try {
            if (existsSync(p)) {
                unlinkSync(p);
                removed.push(p);
            }
        } catch (e) {
            l.warn(`孤儿 ${suffix} 删不掉：${msgOf(e)}`, 'orphan-wal-unlink-fail');
        }
    }
    return removed;
}

/** 关库前 TRUNCATE checkpoint，失败也要关（#103：不 checkpoint 会毒化下次打开）。 */
function checkpointAndClose(db) {
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
        /* WAL 可能未激活（只读库/非 WAL 库）——照 1.2.2 静默 */
    }
    try {
        db.close();
    } catch {
        /* 已关闭/关闭失败：不吞调用方的清理流程 */
    }
}

/**
 * 打开（或创建）一个库。返回句柄 { db, close, path }。
 *
 * 失败处理（任务书三个必须之②）：
 *   打开抛错且 isCorruption → 删 .db/-wal/-shm 三件 → 重开一次；
 *   第二次还失败 → throw err('SQLITE_CORRUPT')，**不静默**。
 *
 * @param {string} dbPath 绝对路径（调用方负责围栏：02-project.isInside）
 * @param {{readonly?:boolean, busyTimeoutMs?:number, log?:ReturnType<createLogger>['forScope']}} [opts]
 * @returns {{db:DatabaseSync, close:()=>void, path:string}}
 */
export function openDB(dbPath, opts = {}) {
    if (typeof dbPath !== 'string' || dbPath === '') {
        throw new TypeError('storage.openDB(): dbPath 必须是非空字符串');
    }
    cleanOrphanedWAL(dbPath);

    const openOnce = () => {
        const db = new DatabaseSync(dbPath, { readOnly: opts.readonly ?? false });
        try {
            if (opts.readonly) {
                // 只读形态（S-2 的 read-only 态会用）：journal_mode/synchronous 都是
                // 写操作，exec 会炸 —— 只读时一条 PRAGMA 不上，能读就行。
                if (opts.busyTimeoutMs !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs)}`);
            } else {
                if (opts.busyTimeoutMs !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs)}`);
                applyPragmas(db);
            }
        } catch (e) {
            try {
                db.close();
            } catch { /* ignore */ }
            throw e;
        }
        return db;
    };

    let db;
    try {
        db = openOnce();
    } catch (e) {
        const msg = msgOf(e);
        if (!isCorruption(msg)) throw e;
        // 损坏回退：删三件重开一次（不是改名保留 —— 新引擎的库定位为可再生的
        // 索引缓存，真数据在源文件；且"改名保留"会把 GB 级坏文件留在 Temp 里，
        // 生命周期块的 M-3 抽检才是报警正道。任务书 A §03-必须② 拍板：删三件。）
        l.warn(`库损坏，删三件重开一次：${dbPath}`, 'corrupt-reset');
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                unlinkSync(dbPath + suffix);
            } catch { /* 可能本就不存在 */ }
        }
        try {
            db = openOnce();
        } catch (e2) {
            throw err('SQLITE_CORRUPT', { path: dbPath, first: msg, second: msgOf(e2) });
        }
    }

    let closed = false;
    return {
        db,
        path: dbPath,
        close() {
            if (closed) return;
            closed = true;
            checkpointAndClose(db);
        },
    };
}

/**
 * closeDB：兼容直接扔句柄或裸 db 两种用法（04-store 的迁移收尾会传句柄）。
 * 幂等：重复调用只 checkpoint+close 一次。
 */
export function closeDB(handleOrDb) {
    if (!handleOrDb) return;
    if (typeof handleOrDb.close === 'function' && handleOrDb.db === undefined && typeof handleOrDb.exec === 'function') {
        checkpointAndClose(handleOrDb); // 裸 DatabaseSync
        return;
    }
    handleOrDb.close(); // openDB 句柄：内部已幂等
}

/**
 * SQLITE_BUSY 重试（同步；照 1.2.2 的等待语义 —— 整条链是同步 API，
 * 用忙等而不是 setTimeout，异步化会把调用方全拖进 promise 链）。
 *
 * @param {Function} fn 同步函数
 * @param {number[]} delays 每次重试前的等待毫秒；默认 100/500/2000（共 4 次尝试）
 */
export function withRetry(fn, delays = [100, 500, 2000]) {
    if (typeof fn !== 'function') throw new TypeError('storage.withRetry(): fn 必须是函数');
    let lastError;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            return fn();
        } catch (e) {
            const msg = msgOf(e);
            if (!isBusy(msg)) throw e; // 非 BUSY 一律立刻上抛（损坏/语法错都别兜）
            lastError = e;
            if (attempt < delays.length) {
                const start = Date.now();
                while (Date.now() - start < delays[attempt]) {
                    /* 忙等：同步重试的既有代价，照 1.2.2 */
                }
            }
        }
    }
    throw new Error(
        `SQLITE_BUSY: database is locked after ${delays.length} retries. Original error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

/** 本块不变量。 */
export const INVARIANTS = Object.freeze([
    'S-3 基线只上 WAL/NORMAL/busy_timeout；autocheckpoint 默认；本轮不调 page_size/mmap/cache',
    '损坏 → 删 .db/-wal/-shm 重开一次；第二次仍损坏 throw SQLITE_CORRUPT（不静默）',
    'close 前 wal_checkpoint(TRUNCATE)，checkpoint 失败也照样 close（try/finally 语义）',
    'withRetry 只吞 BUSY，其它错误立刻上抛',
]);

/** 初始化：确认 node:sqlite 可用（不可用 = 宿主 runtime 太老，引擎起不来就明说）。 */
export async function init(ctx) {
    if (typeof DatabaseSync !== 'function') {
        throw err('RUNTIME_MISSING', { reason: 'node:sqlite DatabaseSync 不存在：需要 node ≥ 22.5 的宿主运行时' });
    }
    ctx.storage = { openDB, closeDB, withRetry, isCorruption, isBusy, cleanOrphanedWAL };
    return { name: NAME, driver: 'node:sqlite' };
}
