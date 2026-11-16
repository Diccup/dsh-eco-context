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
 * 16-entry — 装配层（把 17 块拼成一个可用的引擎实例）
 *
 * 干什么：拿到 db 连接后，按依赖顺序建出 writer / reader / memory / recall / lifecycle / hooks / tools，
 *        并把它们挂到 ctx 上。**这是唯一知道"谁跟谁拼"的地方**，其余块只认构造函数。
 * 为什么这样：块之间不许跨块 import（D2），那就必须有一个装配点做中转 —— 参 2.0 的 assembly 层。
 * 边界：只做装配与生命周期（close/dispose），不含业务判断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SOURCES_DDL, SCHEMA_VERSION } from '../../libs/sql.js';
import { chunkTableDDL } from '../../libs/sql.js';
import { ensureSourcesUnique } from '../../libs/sql.js';
import { err } from '../../libs/err.js';
import { userVersionState } from '../01-core/index.js';
import { openDB, closeDB } from '../03-storage/index.js';
import { createWriter } from '../08-writer/index.js';
import { createReader } from '../09-reader/index.js';
import { createMemory, openMemoryDB } from '../11-memory/index.js';
import { createRecall } from '../10-recall/index.js';
import { createLifecycle } from '../12-lifecycle/index.js';
import { createHooks } from '../15-hooks/index.js';
import { createTools } from '../14-tools/index.js';
import * as analyze from '../05-analyze/index.js';
import * as gram from '../06-gram/index.js';
import * as tokenize from '../07-tokenize/index.js';
import * as projectModule from '../02-project/index.js';
import { assertColumnOrder } from '../../libs/sql.js';

export const NAME = 'entry';
export const INVARIANTS = [
    '唯一的装配点：块之间不许跨块 import，谁跟谁拼只有这里知道',
    'user_version 三态在这里守（v0 有表拒迁 / v>认知只读）',
    'close 必须关临时库与长久库（不 leak 句柄）',
];

/** 数一下库里有多少表（user_version=0 时判断老库用）。 */
function countTables(db) {
    return db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().c;
}

/**
 * 装配一个完整引擎。
 * @param {{contentDir:string, memoryPath?:string, dbPath?:string, level?:string, plugs?:object, web?:object}} opts
 */
export async function assemble(opts = {}) {
    const { contentDir, dbPath, level = 'info' } = opts;
    if (!contentDir) throw err('NO_INPUT', { reason: 'assemble 需要 contentDir' });

    fs.mkdirSync(contentDir, { recursive: true });
    const mainPath = dbPath ?? path.join(contentDir, 'content.db');
    const memoryPath = opts.memoryPath ?? mainPath.replace(/\.db$/, '.persistent.db');

    // ── ① 打开临时库（内容库）──
    //
    // ★ 2026-11-04 P3 #17：**改走 03-storage.openDB**（原来裸 `new DatabaseSync(mainPath)`）。
    //   为什么这条是真缺陷：裸开库拿不到三件东西 ——
    //     ① `withRetry` 的 BUSY 语义（busy_timeout 只在 PRAGMA 里设，有竞争时直接 BUSY 失败）；
    //     ② 关库时的 `wal_checkpoint(TRUNCATE)`（不 checkpoint 会毒化下次打开，#103）；
    //     ③ 孤儿 -wal/-shm 清理（Windows 崩溃残留会让"新建库"报 file is not a database，#244）。
    //   三条都是 03-storage 写了、但装配路径从没走过的能力（"形式在位 ≠ 语义在位"同族）。
    const handle = openDB(mainPath);
    const db = handle.db;

    const tables = countTables(db);
    const uv = db.prepare('PRAGMA user_version').get().user_version;
    const state = userVersionState(uv, tables);

    if (state === 'refuse-v0-with-tables') {
        closeDB(handle);
        throw err('USER_VERSION_MISMATCH', { userVersion: uv, tables, reason: 'v0 且有表 = 老库，拒迁（不许静默重建=不许静默删库）' });
    }
    if (state === 'read-only') {
        closeDB(handle);
        throw err('READ_ONLY_SCHEMA', { userVersion: uv, known: SCHEMA_VERSION });
    }
    if (state === 'fresh') {
        db.exec(SOURCES_DDL);
        db.exec(chunkTableDDL('chunks', 'porter unicode61 remove_diacritics 2'));
        db.exec(chunkTableDDL('chunks_trigram', 'trigram'));
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        assertColumnOrder(db, 'chunks');
        assertColumnOrder(db, 'chunks_trigram');
    }

    // ★ R15（2026-11-04 测试汇总·并发专项）：`sources(label)` 唯一索引。
    //   为什么必须挂在这里：**装配路径走的是本块自带的这一小段建表**（上面 24 行），
    //   06/04-store 的 migrate()/initSchema() 根本不在装配链上 —— 只在那边加会
    //   "门里绿、装机不生效"（本项目最贵的那条教训：改哪里 ≠ 生效哪里）。
    //   · fresh 刚落表 → 必成功；
    //   · ready 老库 → 幂等补建；有重复 label 就**不建**并告警（哪份该留是维护方的事）。
    //   不升 user_version：这是定稿结构本该有的约束，不是新结构（维护方口径：稳定前版本号不变）。
    {
        let unique = { ok: true, duplicates: [] };
        try {
            unique = ensureSourcesUnique(db);
        }
        catch (e) {
            unique = { ok: false, duplicates: [], error: e?.message ?? String(e) };
        }
        if (!unique.ok) {
            const why = unique.error
                ? `建索引失败：${unique.error}`
                : `${unique.duplicates.length} 组重复 label（不删数据）：${unique.duplicates.slice(0, 5).map((d) => `${d.label}×${d.n}`).join(' | ')}`;
            try { opts.log?.warn?.(`sources(label) 唯一索引未建 —— ${why}`, 'sources-unique'); }
            catch { /* 日志坏不拖装配 */ }
        }
    }

    // ── ② 装配 17 块的实例（块之间通过这里中转，不跨块 import）──
    // ★ P3 #13：`writer` 要拿到 project 块（目录遍历 `walkDirectoryDetailed` 在那边）——
    //   原来传 `opts.project ?? null`，装配层从没给过 → `op:index {dir}` 一调就抛
    //   「目录写入需要 project 块」。project 是本引擎自己的块，直接 import 拿。
    const writer = createWriter({ db, analyze, gram, project: opts.project ?? projectModule });
    const reader = createReader({ db, tokenize, gram, writer, dbPath: mainPath, currentSessionId: opts.sessionId ?? '' });
    const memoryDb = openMemoryDB(memoryPath);
    const memory = createMemory({ db: memoryDb });
    const recall = createRecall({ reader, memory });
    const lifecycle = createLifecycle({ db, contentDir, dbPath: mainPath });
    const hooks = createHooks({ writer, recall });

    // ── ②b D-1 启动删线（2026-11-04 P3 #16）──
    //   1.2.2 在 getStore() 里启动就跑 `cleanupStaleSources(14)`；1.0.0 只在 op:maint 手动跑
    //   → 造一条 30 天前的 source，装配后仍在（实测 sources=2）。这里补上：
    //   **默认干跑观察，只有真装成"生产形态"才真删**？不 —— 规格 D-1 要求启动即删，
    //   且判据 `COALESCE(accessed_ts, indexed_at)` 是安全垫（accessed_ts=NULL 退回 indexed_at）。
    //   真删走 dryRun:false；失败静默（启动不该因为清理失败而装不上）。
    let startupRetention = null;
    try {
        startupRetention = lifecycle.retention({ days: 14, dryRun: false });
    }
    catch (e) {
        startupRetention = { error: e.message };
    }
    // 整库文件级清理（D-4：mtime 超期 / 僵尸库），.persistent.db 被排除
    let fileCleanup = null;
    try { fileCleanup = lifecycle.cleanupStaleContentDBs(contentDir, 14); }
    catch { fileCleanup = null; }

    // ── ③ 工具面（14-tools 需要 sandbox：由调用方注入，缺就走 RUNTIME_MISSING）──
    const sandbox = opts.sandbox ?? null;
    const registry = opts.registry;
    const tools = createTools({
        registry, writer, reader, memory, recall, lifecycle, sandbox, web: opts.web ?? null,
        // ★ 2026-11-04 P3 #12：purger **现在默认就是 lifecycle.purge** ——
        //   原来是 `opts.purger ?? null`，平台层从没传过 → 每个 op:purge 都报
        //   「purge 实现未注入」。实现落在 12-lifecycle（数据在那边），这里注入引用。
        purger: opts.purger ?? ((args) => lifecycle.purge(args)),
        // ★ 2026-11-05 Tool Switch：宿主能力，由 platform 注入（引擎独立跑为 null →
        //   op:switch 给 NO_HOST_CAP 的可读错误，而不是静默说"关好了"）。
        toolSwitch: opts.toolSwitch ?? null,
        // ★ 2026-11-06 S9.44：道 A 的真实遥测口（platform 注入 ours 的 hintState）。
        //   不注入 = null → op:stats 回退读引擎 10-recall 那个恒 0 的池（旧行为）。
        hintState: opts.hintState ?? null,
    });

    const cleanups = [
        () => { try { memoryDb.close(); } catch { /* 忽略 */ } },
        // ★ P3 #17：关库走 03-storage.closeDB（内部自带 wal_checkpoint(TRUNCATE)）
        () => { try { closeDB(handle); } catch { /* 忽略 */ } },
    ];

    return {
        db, memoryDb, handle,
        writer, reader, memory, recall, lifecycle, hooks, tools,
        state,
        startupRetention,
        fileCleanup,
        paths: { content: mainPath, memory: memoryPath },
        async call(op, args) {
            const entry = tools.get(op);
            if (!entry) throw err('UNKNOWN_OP', { op, available: tools.ops() });
            return entry.call(args ?? {});
        },
        close() {
            for (const fn of cleanups.reverse()) { try { fn(); } catch { /* 忽略 */ } }
        },
    };
}

export function init(ctx) { ctx.assemble = assemble; }
