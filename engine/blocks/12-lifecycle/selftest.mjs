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
 * 12-lifecycle/selftest.mjs — 单跑必绿（T-4 删线演练 + T-10 user_version）
 *
 * 测什么：① plan 只读不删 ② 不给 dryRun 就真删 → 拒收（假开关教训）③ 三表同判据同事务
 *        ④ 删线判据 = COALESCE(accessed_ts, indexed_at)（T-4 三组：NULL/昨天/今天）
 *        ⑤ integrity 只报警不重建 ⑥ .persistent.db 不被目录扫描删 ⑦ 僵尸判据开库读 MAX
 *        ⑧ checkpoint PASSIVE 不卡读者
 */
import assert from 'node:assert/strict';
import { makeTempRunDir } from '../../libs/tempdir.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLifecycle } from './index.js';
import { chunkTableDDL, SOURCES_DDL } from '../../libs/sql.js';

const dir = makeTempRunDir('lifecycle');
const dbPath = path.join(dir, 'main.db');
function cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }

try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SOURCES_DDL);
    db.exec(chunkTableDDL('chunks', 'porter unicode61'));
    db.exec(chunkTableDDL('chunks_trigram', 'trigram'));
    db.exec('PRAGMA user_version = 1');

    const lc = createLifecycle({ db, contentDir: dir, dbPath });
    let n = 0;
    const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

    // 造三组数据：NULL / 昨天（30 天前）/ 今天
    function seed(label, indexedAt, accessedTs) {
        const id = Number(db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, accessed_ts) VALUES (?, 1, 0, ?, ?)')
            .run(label, indexedAt, accessedTs).lastInsertRowid);
        db.prepare('INSERT INTO chunks (title, content, script_ngrams, source_id, content_type, source_category, session_id, event_id, timestamp, accessed_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
            .run(label, 'x', '', id, 'prose', null, '', '', indexedAt);
        db.prepare('INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp, accessed_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
            .run(label, 'x', id, 'prose', null, '', '', indexedAt);
        return id;
    }
    const nowStr = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const daysAgo = (d) => new Date(Date.now() - d * 86400_000).toISOString().replace('T', ' ').slice(0, 19);

    seed('null-old', daysAgo(30), null);              // NULL accessed_ts + 30 天 → COALESCE 退化为 indexed_at → 删
    seed('acc-yesterday', daysAgo(40), daysAgo(1));   // 40 天但昨天命中过 → 不删（续命生效）
    seed('today', nowStr(), nowStr());                // 今天 → 不删

    t('① plan 只读：报数正确且一行没删', () => {
        const before = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
        const p = lc.plan(14);
        assert.equal(p.wouldDeleteSources, 1, `应只删 null-old，实际 ${p.wouldDeleteSources}`);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, before, 'plan 删了东西');
        assert.ok(p.samples.length > 0);
    });

    t('② 不给 dryRun 就真删 → 拒收（假开关教训）', () => {
        let threw = null;
        try { lc.retention({ days: 14 }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'RETENTION_NEEDS_EXPLICIT', `实际 ${threw?.code}`);
        assert.ok(threw.details.plan, '拒收里没附 plan 报数');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, 3, '拒收却删了');
    });

    t('③ dryRun:true 只 plan 不删', () => {
        const r = lc.retention({ days: 14, dryRun: true });
        assert.equal(r.wouldDeleteSources, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, 3);
    });

    t('④ T-4 三组：dryRun:false 真删 → 只删 NULL 且超期的那个', () => {
        const r = lc.retention({ days: 14, dryRun: false });
        assert.equal(r.deletedSources, 1, JSON.stringify(r));
        assert.equal(r.deletedChunks, 1);
        assert.equal(r.deletedTrigram, 1);
        const labels = db.prepare('SELECT label FROM sources ORDER BY id').all().map((x) => x.label);
        assert.deepEqual(labels, ['acc-yesterday', 'today'], `剩：${labels}`);
    });

    t('⑤ 三表同判据：删完后不存在孤儿块', () => {
        const orphan1 = db.prepare('SELECT COUNT(*) c FROM chunks WHERE source_id NOT IN (SELECT id FROM sources)').get().c;
        const orphan2 = db.prepare('SELECT COUNT(*) c FROM chunks_trigram WHERE source_id NOT IN (SELECT id FROM sources)').get().c;
        assert.equal(orphan1, 0, `chunks 孤儿 ${orphan1}`);
        assert.equal(orphan2, 0, `chunks_trigram 孤儿 ${orphan2}`);
    });

    t('⑥ integrity 返回 ok，且带 never-auto-rebuild 动作标记', () => {
        const r = lc.integrityCheck();
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.action, 'never-auto-rebuild');
    });

    t('⑦ .persistent.db 不被目录扫描删', () => {
        const persistent = path.join(dir, 'keep.persistent.db');
        fs.writeFileSync(persistent, 'fake');
        const old = new Date(Date.now() - 60 * 86400_000);
        fs.utimesSync(persistent, old, old);
        const r = lc.cleanupStaleContentDBs(dir, 14);
        assert.ok(fs.existsSync(persistent), '.persistent.db 被删了 —— 红线破了');
        assert.equal(r.skippedPersistent, 1, JSON.stringify(r));
    });

    t('⑧ 僵尸判据：WAL 静置但库刚活动过 → 不是僵尸', () => {
        const zombie = path.join(dir, 'active.db');
        const zdb = new DatabaseSync(zombie);
        zdb.exec(SOURCES_DDL);
        zdb.exec(chunkTableDDL('chunks', 'porter unicode61'));
        zdb.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, accessed_ts) VALUES (?,0,0,?,?)')
            .run('fresh', nowStr(), nowStr());
        // 让 WAL 有内容且 mtime 很老
        zdb.exec("INSERT INTO chunks (title,content,script_ngrams,source_id,content_type,source_category,session_id,event_id,timestamp,accessed_ts) VALUES ('t','c','',1,'prose',NULL,'','','${nowStr()}',NULL)");
        zdb.close();
        const old = new Date(Date.now() - 2 * 3600_000);
        try { fs.utimesSync(zombie + '-wal', old, old); } catch { /* WAL 可能已被 checkpoint */ }
        const isZ = lc.isZombieDB(zombie);
        assert.equal(isZ, false, '刚活动过的库被判成僵尸 —— 会误杀活跃库');
    });

    t('⑨ checkpoint PASSIVE 返回结果且不报错', () => {
        const r = lc.checkpoint('PASSIVE');
        assert.equal(r.mode, 'PASSIVE');
        assert.ok(Array.isArray(r.result));
    });

    t('⑩ doctor 报出基线项（journal/synchronous/user_version/integrity）', () => {
        const d = lc.doctor();
        assert.ok(d.total >= 4, `总检查项 ${d.total}`);
        const names = d.checks.map((c) => c.name);
        assert.ok(names.some((x) => x.includes('journal_mode')));
        assert.ok(names.some((x) => x.includes('user_version')));
        assert.ok(d.checks.every((c) => typeof c.fix === 'string' && c.fix.length > 0), '有 FAIL 项没带修法');
    });

    t('⑪ vacuum 默认只报体积预估，不真跑', () => {
        const r = lc.vacuum({});
        assert.equal(r.dryRun, true);
        assert.ok(r.fileBytes >= 0);
        assert.ok(typeof r.reclaimableBytes === 'number');
    });

    t('⑫ cleanupStaleDBs PID 探活：探不到的死 PID 库被清', () => {
        const dead = path.join(dir, 'context-mode-999999.db');
        fs.writeFileSync(dead, 'x');
        const c = lc.cleanupStaleDBs(dir);
        assert.ok(c >= 1, `清了 ${c}`);
        assert.ok(!fs.existsSync(dead));
    });

    console.log(`\n12-lifecycle: ${n} 项全绿`);
    db.close();
}
catch (e) {
    console.error('12-lifecycle selftest 失败：', e.message, '\n', e.stack?.split('\n').slice(0, 3).join('\n'));
    process.exitCode = 1;
}
finally { cleanup(); }
