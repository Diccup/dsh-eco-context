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
 * 04-store/selftest.mjs — 单跑即绿：node blocks\04-store\selftest.mjs
 *
 * 这就是 G2a 的核心六断言（任务书 A §二·04-selftest），一条不省：
 *   ① 空库建表 → user_version == 1
 *   ② assertColumnOrder 对 chunks 与 chunks_trigram 都过（列序逐位）
 *   ③ 12 条查询模板：bm25 权重串出现次数 == 12，每条 bm25( 的权重参数 == 3
 *   ④ user_version=0 且有表的库 → migrate throw 且 code === 'USER_VERSION_MISMATCH'
 *   ⑤ user_version=2 的库 → throw READ_ONLY_SCHEMA
 *   ⑥ PRAGMA integrity_check 返回 ok
 * 另加红线复验：④ 拒迁后原表原数据必须还在（不许静默删库）。
 *
 * 说明：本 selftest 直接使 node:sqlite（不 import 03-storage —— D2 静态扫描
 * 对 selftest 同样为 0 才稳）；迁移只依赖"已打开的 db"，正是 04 的职责边界。
 */

import assert from 'node:assert/strict';
import { tempDir as resolveTempDir } from '../../libs/tempdir.js';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NAME, Schema, initSchema, migrate, tableCount, userVersion, schemaState, searchStatementTemplates, verifyColumnOrder, init, TOKENIZERS } from './index.js';
import {CHUNK_COLUMNS, SCHEMA_VERSION, SOURCES_DDL, chunkTableDDL, BM25_WEIGHTS } from '../../libs/sql.js';

const TEMP_ROOT = resolveTempDir();

let n = 0;
async function ok(label, fn) {
    await fn();
    n++;
    console.log(`  ✓ ${label}`);
}

mkdirSync(TEMP_ROOT, { recursive: true });
const tmp = mkdtempSync(join(TEMP_ROOT, 's9-selftest-04-'));
const dbAt = (name) => join(tmp, `${name}-${process.pid}.db`);
const opened = [];
function freshDb(name) {
    const db = new DatabaseSync(dbAt(name));
    opened.push(db);
    return db;
}

try {
    console.log(`[selftest] ${NAME}`);

    // ── ① 空库建表 → user_version == 1 ──────────────────
    await ok('① 空库 → migrate → user_version === 1，四表齐', () => {
        const db = freshDb('g2a-1');
        assert.equal(tableCount(db), 0, '新库必须空');
        assert.equal(schemaState(db), 'fresh');
        const res = migrate(db);
        assert.equal(res.state, 'ready');
        assert.equal(userVersion(db), SCHEMA_VERSION, 'user_version 必须落 1');
        const names = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r) => r.name);
        for (const t of ['sources', 'chunks', 'chunks_trigram', 'vocabulary']) {
            assert.ok(names.includes(t), `缺表 ${t}（实际：${names.join(',')}）`);
        }
        // 幂等复跑：第二次 migrate 直通，不重复建、版本不动
        const res2 = migrate(db);
        assert.equal(res2.state, 'ready');
        assert.equal(userVersion(db), 1);
        // sources 8 列且末尾是 accessed_ts（SOURCES_DDL 契约）
        const cols = db.prepare("SELECT name FROM pragma_table_info('sources')").all().map((r) => r.name);
        assert.deepEqual(cols, ['id', 'label', 'chunk_count', 'code_chunk_count', 'indexed_at', 'file_path', 'content_hash', 'accessed_ts']);
    });

    // ── ② 列序逐位断言 ──────────────────
    await ok('② 列序逐位断言：chunks 有 script_ngrams（第 3 列）、trigram 没有；两表各自逐位', () => {
        const db = freshDb('g2a-2');
        migrate(db);
        const a = verifyColumnOrder(db, 'chunks');
        const b = verifyColumnOrder(db, 'chunks_trigram');
        // libs 版返回 pragma_table_xinfo 全列（含 FTS5 影子列 chunks/rank…，排在契约列之后），
        // 逐位断言的语义 = 前缀与 CHUNK_COLUMNS 完全一致。
        assert.deepEqual(a.slice(0, CHUNK_COLUMNS.porter.length), [...CHUNK_COLUMNS.porter]);
        assert.deepEqual(b.slice(0, CHUNK_COLUMNS.trigram.length), [...CHUNK_COLUMNS.trigram]);
        // ★ 库定稿 §1.2：**表数量不变，只加一列** —— 只有 chunks 加 script_ngrams
        assert.equal(CHUNK_COLUMNS.porter[2], 'script_ngrams', 'chunks 第 3 列必须是 script_ngrams');
        assert.ok(!CHUNK_COLUMNS.trigram.includes('script_ngrams'), 'trigram 表不该有 gram 列（写放大会爆）');
        assert.equal(CHUNK_COLUMNS.porter.length - CHUNK_COLUMNS.trigram.length, 1, '只差一列');
        assert.ok(a[0] === 'title' && a[1] === 'content');
        // tokenizer 差异只在 tokenize 子句：porter unicode61 vs trigram
        const ddlP = chunkTableDDL('chunks', TOKENIZERS.porter);
        const ddlT = chunkTableDDL('chunks_trigram', TOKENIZERS.trigram);
        assert.match(ddlP, /tokenize='porter unicode61'/);
        assert.match(ddlT, /tokenize='trigram'/);
        // 破坏列序必须炸（护栏本身有效性的反向证据）：造一张列序错位的表
        const bad = freshDb('g2a-2-bad');
        bad.exec("CREATE VIRTUAL TABLE chunks USING fts5(content, title, tokenize='unicode61')");
        assert.throws(() => verifyColumnOrder(bad, 'chunks'), /列序契约被破坏/);
        // 少列也必须炸：契约第 3 列位取不到 → 期望 source_id / 实际 undefined
        const few = freshDb('g2a-2-few');
        few.exec("CREATE VIRTUAL TABLE chunks USING fts5(title, content, tokenize='unicode61')");
        assert.throws(() => verifyColumnOrder(few, 'chunks'), /列序契约被破坏/);
    });

    // ── ③ 12 条 bm25 查询模板 ──────────────────
    await ok('③ 12 条查询模板：bm25 恰 12 处，权重个数按表区分（chunks 3 / trigram 2）', () => {
        const stmts = searchStatementTemplates();
        assert.equal(stmts.length, 12, '必须恰 12 条');
        const total = stmts.join('\n').match(/bm25\(/g);
        assert.equal(total.length, 12, 'bm25( 出现次数必须 == 12');
        for (const [i, s] of stmts.entries()) {
            const m = s.match(/bm25\(([^)]*)\)/);
            assert.ok(m, `第 ${i} 条找不到 bm25(...)`);
            const args = m[1].split(',').map((x) => x.trim());
            const table = args[0];
            // ★ 权重个数 = 该表的**索引列数**（CHUNK_COLUMNS）：chunks 3 列 → 3 个权重；
            //   chunks_trigram 只有 title/content → 2 个。漏一个 = 该列吃默认权重 = 排序悄悄变。
            const expect = BM25_WEIGHTS[table];
            assert.ok(expect, `第 ${i} 条 bm25 表名无法识别：${table}`);
            assert.deepEqual(args.slice(1), expect.map((w) => w.toFixed(1)),
                `第 ${i} 条（${table}）权重必须 ${expect.join('/')}，实际 ${args.slice(1).join('/')}`);
            assert.match(s, /highlight\([A-Za-z_]+, 1, char\(2\), char\(3\)\)/, `第 ${i} 条 highlight 下标必须写死 1=content`);
        }
        const db = freshDb('g2a-3-compile');
        migrate(db);
        for (const [i, s] of stmts.entries()) {
            assert.doesNotThrow(() => db.prepare(s), `第 ${i} 条模板 prepare 失败`);
        }
        // 表名分布：chunks × 6、chunks_trigram × 6
        assert.equal(stmts.filter((s) => /FROM chunks\b/.test(s)).length, 6);
        assert.equal(stmts.filter((s) => /FROM chunks_trigram\b/.test(s)).length, 6);
    });

    // ── ④ v0 有表 → 拒迁（且原表原数据一根毛都不动）──────────────────
    await ok('④ user_version=0 且有表 → throw USER_VERSION_MISMATCH，表与数据原样保留', () => {
        const db = freshDb('g2a-4');
        db.exec('CREATE TABLE legacy_marker(x TEXT)'); // 老库自己的表
        db.exec("INSERT INTO legacy_marker VALUES ('do-not-touch')");
        db.exec('CREATE TABLE sources(id INTEGER PRIMARY KEY, label TEXT)'); // 老结构缺 accessed_ts
        db.exec("INSERT INTO sources VALUES (7, 'old')");
        assert.equal(userVersion(db), 0);
        assert.equal(schemaState(db), 'refuse-v0-with-tables');
        assert.throws(() => migrate(db), (e) => {
            assert.equal(e.code, 'USER_VERSION_MISMATCH');
            assert.match(e.message, /不许静默重建|老库/);
            return true;
        });
        // 红线复验：拒迁之后老表老数据必须还在（引擎没猜、没删）
        assert.equal(db.prepare("SELECT x FROM legacy_marker").get().x, 'do-not-touch');
        assert.equal(db.prepare('SELECT label FROM sources WHERE id = 7').get().label, 'old');
        assert.equal(userVersion(db), 0, 'throw 路径绝不许顺手改 user_version');
    });

    // ── ⑤ v>认知 → 只读报警 ──────────────────
    await ok('⑤ user_version=2 → throw READ_ONLY_SCHEMA', () => {
        const db = freshDb('g2a-5');
        db.exec('PRAGMA user_version = 2');
        assert.equal(schemaState(db), 'read-only');
        assert.throws(() => migrate(db), (e) => {
            assert.equal(e.code, 'READ_ONLY_SCHEMA');
            return true;
        });
        const db2 = freshDb('g2a-5b');
        db2.exec('PRAGMA user_version = 99');
        assert.throws(() => migrate(db2), (e) => e.code === 'READ_ONLY_SCHEMA');
        assert.equal(schemaState(db2), 'read-only');
    });

    // ── ⑥ integrity_check ──────────────────
    await ok('⑥ PRAGMA integrity_check 返回 ok（含 Schema 路径）', () => {
        const db = freshDb('g2a-6');
        const s = new Schema(db); // 构造即迁移
        assert.equal(s.state, 'ready');
        assert.equal(s.version, 1);
        assert.equal(s.integrityCheck(), 'ok');
        // FTS5 结构自检：'integrity-check' 命令不许报坏
        assert.doesNotThrow(() => db.prepare("INSERT INTO chunks(chunks) VALUES('integrity-check')").run());
        const order = s.checkColumnOrder();
        assert.deepEqual(order.chunks.slice(0, 10), CHUNK_COLUMNS.porter);
        // 句柄形态兼容：{db} 包装也能构造
        const s2 = new Schema({ db });
        assert.equal(s2.state, 'ready');
        assert.throws(() => new Schema(null), TypeError);
        assert.throws(() => new Schema({ nope: 1 }), TypeError);
    });

    // ── 附加：initSchema 直调幂等 + init(ctx) 门面 ──────────────────
    await ok('附加：initSchema 幂等直调；init(ctx) 挂 store 门面', async () => {
        const db = freshDb('g2a-extra');
        initSchema(db);
        const before = tableCount(db);
        initSchema(db); // IF NOT EXISTS 复跑
        assert.equal(tableCount(db), before);
        assert.equal(userVersion(db), 0, 'initSchema 直调不改版本 —— 版本只归 migrate');
        const ctx = {};
        const res = await init(ctx);
        assert.equal(res.name, 'store');
        assert.equal(res.schemaVersion, SCHEMA_VERSION);
        assert.equal(typeof ctx.store.Schema, 'function');
        // SOURCES_DDL 常量本体不许被块内改写（契约冻结件只读）
        assert.match(SOURCES_DDL, /accessed_ts TEXT/);
    });

    console.log(`[selftest] ${NAME} — ${n} 条断言全绿 ✅（G2a 六条 ①-⑥ 全含）`);
} finally {
    for (const db of opened) {
        try {
            db.close();
        } catch { /* ignore */ }
    }
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(tmp)) throw new Error(`临时目录未清干净：${tmp}`);
}
