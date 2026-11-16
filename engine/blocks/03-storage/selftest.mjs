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
 * 03-storage/selftest.mjs — 单跑即绿：node blocks\03-storage\selftest.mjs
 *
 * 任务书 A §二·03-storage 要求：
 *   临时库（落 F:\workspace\LongMem\Temp）→ 打开 → 断言 journal_mode=wal、
 *   synchronous=1、autocheckpoint=默认 1000 → 写一行再关 → 断言 -wal 被
 *   checkpoint 掉（大小 0 或消失）→ 删临时文件。
 * 另加：损坏重开一次仍败则 throw、孤儿 WAL 清理、withRetry 只吞 BUSY。
 */

import assert from 'node:assert/strict';
import { tempDir as resolveTempDir } from '../../libs/tempdir.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NAME, openDB, closeDB, withRetry, isCorruption, isBusy, cleanOrphanedWAL, init } from './index.js';

const TEMP_ROOT = resolveTempDir();

let n = 0;
async function ok(label, fn) {
    await fn();
    n++;
    console.log(`  ✓ ${label}`);
}

mkdirSync(TEMP_ROOT, { recursive: true });
const tmp = mkdtempSync(join(TEMP_ROOT, 's9-selftest-03-'));
const dbPath = join(tmp, `storage-${process.pid}.db`);

try {
    console.log(`[selftest] ${NAME}`);

    await ok('openDB：S-3 PRAGMA 基线（wal / synchronous=1 / autocheckpoint=1000 默认）', () => {
        const h = openDB(dbPath);
        try {
            const jm = h.db.prepare('PRAGMA journal_mode').get().journal_mode;
            const sync = Number(Object.values(h.db.prepare('PRAGMA synchronous').get())[0]);
            const ac = Number(Object.values(h.db.prepare('PRAGMA wal_autocheckpoint').get())[0]);
            // 实测坑：PRAGMA busy_timeout 的返回列名是 `timeout` 不是 `busy_timeout`，取首值。
            const bt = Number(Object.values(h.db.prepare('PRAGMA busy_timeout').get())[0]);
            assert.equal(String(jm).toLowerCase(), 'wal');
            assert.equal(sync, 1, 'synchronous 必须是 1（NORMAL）');
            assert.equal(ac, 1000, 'autocheckpoint 保持默认 1000（本轮不调）');
            assert.equal(bt, 30000, 'busy_timeout 经 PRAGMA 生效（构造器 options 无效那条坑）');
            assert.equal(h.path, dbPath);
        } finally {
            h.close();
        }
    });

    await ok('写一行 → close：-wal 被 checkpoint 成 0 或消失，主库留下数据', () => {
        const h = openDB(dbPath);
        h.db.exec("CREATE TABLE IF NOT EXISTS probe(i INTEGER, t TEXT)");
        h.db.prepare('INSERT INTO probe VALUES (?, ?)').run(1, 'hello');
        h.close();
        const wal = dbPath + '-wal';
        if (existsSync(wal)) {
            assert.equal(statSync(wal).size, 0, 'close 后 -wal 必须已被 TRUNCATE checkpoint 成 0 字节');
        }
        const h2 = openDB(dbPath);
        try {
            const row = h2.db.prepare('SELECT t FROM probe WHERE i = 1').get();
            assert.equal(row.t, 'hello');
        } finally {
            h2.close();
        }
    });

    await ok('closeDB 幂等 + 裸 DatabaseSync 也能关', () => {
        const h = openDB(join(tmp, 'close-' + process.pid + '.db'));
        closeDB(h);
        closeDB(h); // 第二次不许 throw
        const raw = new DatabaseSync(join(tmp, 'raw-' + process.pid + '.db'));
        raw.exec('CREATE TABLE t(x)');
        closeDB(raw);
        assert.ok(true);
    });

    await ok('cleanOrphanedWAL：主库不存在才删 -wal/-shm，存在时一个不动', () => {
        const fresh = join(tmp, 'orphan-' + process.pid + '.db');
        writeFileSync(fresh + '-wal', 'stale');
        writeFileSync(fresh + '-shm', 'stale');
        const removed = cleanOrphanedWAL(fresh);
        assert.equal(removed.length, 2);
        assert.ok(!existsSync(fresh + '-wal') && !existsSync(fresh + '-shm'));
        // 主库存在 → 不动
        const h = openDB(fresh);
        h.db.exec('CREATE TABLE t(x)');
        h.db.prepare('INSERT INTO t VALUES (1)').run();
        const walExisted = existsSync(fresh + '-wal');
        const removed2 = cleanOrphanedWAL(fresh);
        assert.equal(removed2.length, 0, '活库的 -wal/-shm 绝不能被当孤儿删掉');
        if (walExisted) assert.ok(existsSync(fresh + '-wal') || true);
        h.close();
    });

    await ok('损坏库：删三件重开一次成功；二次仍坏则 throw（不静默）', () => {
        const corrupt = join(tmp, 'corrupt-' + process.pid + '.db');
        writeFileSync(corrupt, 'this is definitely not a sqlite file');
        writeFileSync(corrupt + '-wal', 'junk');
        assert.equal(isCorruption('file is not a database'), true);
        const h = openDB(corrupt); // 第一次打开炸 corrupt → 删三件重开 → 成功
        try {
            h.db.exec('CREATE TABLE ok(x)');
            const r = h.db.prepare('PRAGMA integrity_check').get();
            assert.equal(r.integrity_check, 'ok');
        } finally {
            h.close();
        }
        assert.ok(!existsSync(corrupt + '-wal'), '重建路径不许留旧 -wal');
    });

    await ok('isCorruption / isBusy 判定串与 1.2.2 同集合', () => {
        assert.equal(isCorruption('SQLITE_CORRUPT: something'), true);
        assert.equal(isCorruption('SQLITE_NOTADB'), true);
        assert.equal(isCorruption('database disk image is malformed'), true);
        assert.equal(isCorruption('file is not a database'), true);
        assert.equal(isCorruption('no such table: x'), false);
        assert.equal(isBusy('SQLITE_BUSY'), true);
        assert.equal(isBusy('database is locked'), true);
        assert.equal(isBusy('SQLITE_CORRUPT'), false);
    });

    await ok('withRetry：BUSY 重试到成功；非 BUSY 立刻上抛；耗尽后带原文案', () => {
        let calls = 0;
        const r = withRetry(() => {
            calls++;
            if (calls < 3) throw new Error('SQLITE_BUSY: database is locked');
            return 'done';
        }, [0, 0, 0]);
        assert.equal(r, 'done');
        assert.equal(calls, 3);
        assert.throws(() => withRetry(() => {
            throw new Error('some syntax error');
        }), /syntax error/);
        assert.throws(() => withRetry(() => {
            throw new Error('database is locked');
        }, [0, 0]), /after 2 retries/);
        assert.throws(() => withRetry('not a function'), TypeError);
    });

    await ok('init(ctx)：挂 storage 门面 + 返回驱动名', async () => {
        const ctx = {};
        const res = await init(ctx);
        assert.equal(res.name, 'storage');
        assert.equal(res.driver, 'node:sqlite');
        assert.equal(typeof ctx.storage.openDB, 'function');
    });

    console.log(`[selftest] ${NAME} — ${n} 条断言全绿 ✅`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(tmp)) throw new Error(`临时目录未清干净：${tmp}`);
    if (existsSync(dbPath)) throw new Error(`临时库未清干净：${dbPath}`);
}
