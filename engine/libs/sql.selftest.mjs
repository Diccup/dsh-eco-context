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
 * libs/sql.selftest.mjs — 契约件自验（libs 是所有人共用的，必须自带门）
 *
 * 跑法：node libs/sql.selftest.mjs
 * 测什么：① assertColumnOrder 对正确建表必须过（qfmodel 抓的那个 bug 的回归）
 *        ② 列序被破坏时必须 throw ③ bm25 三参数 ④ DDL 两表列序逐位一致 ⑤ LIKE 转义
 *        ⑥ tx() 正常提交 / 异常回滚 / 嵌套 savepoint
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeTempRunDir } from './tempdir.js';
import {
    CHUNK_COLUMNS, BM25_COLUMNS, BM25_WEIGHTS, HIGHLIGHT_COLUMN_INDEX,
    bm25, highlight, chunkTableDDL, SOURCES_DDL, SCHEMA_VERSION, likeEscape, assertColumnOrder, tx,
} from './sql.js';

const RUN = makeTempRunDir('sql');
const dbPath = path.join(RUN, 's.db');
function cleanup() { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch { /* 忽略 */ } } }

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

try {
    fs.mkdirSync(RUN, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SOURCES_DDL);
    db.exec(chunkTableDDL('chunks', 'porter unicode61'));
    db.exec(chunkTableDDL('chunks_trigram', 'trigram'));

    t('① assertColumnOrder 对正确建表必须过（qfmodel 抓的 bug 回归）', () => {
        assertColumnOrder(db, 'chunks');
        assertColumnOrder(db, 'chunks_trigram');
    });

    t('② 列序契约：chunks 有 gram 列、trigram 没有；两表其余列序一致', () => {
        assert.equal(CHUNK_COLUMNS.porter[0], 'title');
        assert.equal(CHUNK_COLUMNS.porter[1], 'content');
        assert.equal(CHUNK_COLUMNS.porter[2], 'script_ngrams');   // chunks：第 3 列是 gram
        assert.equal(CHUNK_COLUMNS.porter.length, 10);
        // ★ trigram 表**不加** script_ngrams（库定稿 §1.2）→ 9 列且没有 gram
        assert.equal(CHUNK_COLUMNS.trigram.length, 9);
        assert.ok(!CHUNK_COLUMNS.trigram.includes('script_ngrams'), 'trigram 表不该有 gram 列');
    });

    t('③ bm25 权重个数 = 各表索引列数（chunks 3 个 / trigram 2 个）', () => {
        assert.deepEqual(BM25_COLUMNS.chunks, ['title', 'content', 'script_ngrams']);
        assert.deepEqual(BM25_COLUMNS.chunks_trigram, ['title', 'content']);
        assert.equal(bm25('chunks'), 'bm25(chunks, 5.0, 1.0, 1.0)');
        // ★ 权重个数 = 该表索引列数（trigram 2 列 → 2 个权重）
        assert.equal(bm25('chunks_trigram'), 'bm25(chunks_trigram, 5.0, 1.0)');
    });

    t('④ highlight 下标固定 1（content 列）', () => {
        assert.equal(HIGHLIGHT_COLUMN_INDEX, 1);
        assert.equal(highlight('chunks'), 'highlight(chunks, 1, char(2), char(3))');
    });

    t('⑤ chunks DDL 三列有索引；trigram DDL 只有两列', () => {
        const ddl = chunkTableDDL('chunks', 'porter unicode61');
        assert.ok(/^\s+title,$/m.test(ddl), ddl);
        assert.ok(/^\s+content,$/m.test(ddl), ddl);
        assert.ok(/^\s+script_ngrams,$/m.test(ddl), ddl);
        assert.ok(/source_id UNINDEXED/.test(ddl));
        assert.ok(/accessed_ts UNINDEXED/.test(ddl));
        assert.ok(/tokenize='porter unicode61'/.test(ddl));
    });

    t('⑥ sources 8 列（含 accessed_ts，不加 deleted_at）', () => {
        const cols = db.prepare("SELECT name FROM pragma_table_xinfo('sources')").all().map((r) => r.name);
        assert.deepEqual(cols, ['id', 'label', 'chunk_count', 'code_chunk_count', 'indexed_at', 'file_path', 'content_hash', 'accessed_ts']);
        const ddl = SOURCES_DDL;
        assert.ok(!ddl.includes('deleted_at'), 'sources 里出现了 deleted_at（维护方 21:40 明令不加）');
    });

    t('⑦ likeEscape 转义 % _ \\（#646）', () => {
        assert.equal(likeEscape('a%b'), 'a\\%b');
        assert.equal(likeEscape('a_b'), 'a\\_b');
        assert.equal(likeEscape('a\\b'), 'a\\\\b');
    });

    t('⑧ SCHEMA_VERSION = 1（1.0.0 定稿结构，唯一认识的结构）', () => {
        // ★ 2026-11-04 事故回归：迁移脚本曾擅自写 TARGET_VERSION=2 把真库打成 v2，
        //   而这里留 1 → 真库被判 READ_ONLY_SCHEMA → assemble 抛 → registry 0 个 op
        //   → 12 个 op 全 UNKNOWN_OP。
        //   这条断言的语义是：**版本号不由"我改了什么"决定，由"定稿是哪个结构"决定。**
        //   script_ngrams / remove_diacritics 2 都在 1.0.0 定稿里，所以就是 1。
        //   要改成 2 = 改库结构 = 必须先问维护方（"稳定前 1.0.0 都不动"）。
        assert.equal(SCHEMA_VERSION, 1);
    });

    t('⑨ 列序被破坏 → 必须 throw（护栏本身要能拦）', () => {
        const bad = new DatabaseSync(':memory:');
        // 故意把 content 放到 index 2
        bad.exec("CREATE VIRTUAL TABLE chunks USING fts5(title, source_id UNINDEXED, content, tokenize='porter unicode61')");
        let threw = null;
        try { assertColumnOrder(bad, 'chunks'); } catch (e) { threw = e; }
        assert.ok(threw, '列序错了却没 throw');
        bad.close();
    });

    t('⑩ tx：正常提交', () => {
        const r = tx(db, () => {
            db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?,0,0)').run('tx-ok');
            return 'done';
        });
        assert.equal(r, 'done');
        assert.ok(db.prepare('SELECT id FROM sources WHERE label = ?').get('tx-ok'));
    });

    t('⑪ tx：异常自动回滚，行不落盘', () => {
        const before = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
        let threw = null;
        try {
            tx(db, () => {
                db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?,0,0)').run('tx-rollback');
                throw new Error('boom');
            });
        }
        catch (e) { threw = e; }
        assert.equal(threw?.message, 'boom');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, before, '回滚失败，行留下了');
    });

    t('⑫ tx 嵌套：内层失败只回滚内层（savepoint）', () => {
        const before = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
        tx(db, () => {
            db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?,0,0)').run('outer');
            try {
                tx(db, () => {
                    db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?,0,0)').run('inner');
                    throw new Error('inner-boom');
                });
            }
            catch { /* 内层失败被吞，外层继续 */ }
        });
        // 外层提交成功 + 内层回滚 → 只多 1 行
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, before + 1, '嵌套事务语义不对');
    });

    console.log(`\nsql.js: ${n} 项全绿`);
    db.close();
}
catch (e) {
    console.error('sql.selftest 失败：', e.message);
    process.exitCode = 1;
}
finally { cleanup(); }
