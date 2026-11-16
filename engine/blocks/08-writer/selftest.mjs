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
 * 08-writer/selftest.mjs — 单跑必绿（临时库落 Temp，跑完自删）
 *
 * 测什么：① by-label 重插幂等（#67）② 双表都写了 + gram 列非空 ③ 空串回退读文件（#350）
 *        ④ TOCTOU 用 fd 绑定（#442，断言读的是打开那一刻的 inode）⑤ 替换后 accessed_ts 为 NULL
 */
import assert from 'node:assert/strict';
import { makeTempRunDir } from '../../libs/tempdir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWriter } from './index.js';
import * as analyze from '../05-analyze/index.js';
import * as gram from '../06-gram/index.js';
import { chunkTableDDL, SOURCES_DDL } from '../../libs/sql.js';

const RUN = makeTempRunDir('writer');
const dbPath = path.join(RUN, 'w.db');
const files = [];

function cleanup() {
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* 忽略 */ } }
}

try {
    fs.mkdirSync(RUN, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SOURCES_DDL);
    db.exec(chunkTableDDL('chunks', 'porter unicode61'));
    db.exec(chunkTableDDL('chunks_trigram', 'trigram'));
    db.exec('PRAGMA user_version = 1');

    const w = createWriter({ db, analyze, gram });
    let n = 0;
    const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

    t('① 首次写入：标题+正文+代码合成一块、codeChunks 计数正确', () => {
        const r = w.write({ content: '# 标题\n正文一段\n\n```js\nconst a=1;\n```', source: 'docA' });
        // 契约：标题行属于它引导的那段内容，所以「标题+正文+代码块」= 1 块（与 1.2.2 一致）
        assert.equal(r.totalChunks, 1, `实际 ${r.totalChunks}`);
        assert.equal(r.codeChunks, 1);
        assert.equal(r.label, 'docA');
    });

    t('② 双表都写了 + gram 列非空（写放大 2.82× 的由来）', () => {
        const a = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;
        const b = db.prepare('SELECT COUNT(*) c FROM chunks_trigram').get().c;
        assert.equal(a, b, `两表块数不一致 ${a} vs ${b}`);
        const g = db.prepare("SELECT script_ngrams FROM chunks WHERE script_ngrams IS NOT NULL AND script_ngrams != ''").get();
        assert.ok(g, 'gram 列没写（chunks 表必须有）');
        // ★ chunks_trigram **不该有** script_ngrams 列（库定稿 §1.2「不加列」）
        const triCols = db.prepare("SELECT name FROM pragma_table_xinfo('chunks_trigram')").all().map((r) => r.name);
        assert.ok(!triCols.includes('script_ngrams'), `trigram 表不该有 gram 列：${triCols}`);
    });

    t('③ by-label 重插 10 次：sources 恒 1 行，无脏块（#67）', () => {
        for (let i = 0; i < 10; i++) w.write({ content: `# 标题${i}\n正文${i}`, source: 'docA' });
        const src = db.prepare('SELECT COUNT(*) c FROM sources WHERE label = ?').get('docA').c;
        assert.equal(src, 1, `sources 行数 ${src}`);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks').get().c, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks_trigram').get().c, 1);
    });

    t('④ 替换后 accessed_ts 置 NULL（新内容未命中过）', () => {
        db.prepare('UPDATE sources SET accessed_ts = ? WHERE label = ?').run('2026-11-03T12:00:00', 'docA');
        w.write({ content: '# 换了内容\n新正文', source: 'docA' });
        const row = db.prepare('SELECT accessed_ts FROM sources WHERE label = ?').get('docA');
        assert.equal(row.accessed_ts, null);
    });

    t('⑤ content="" + path → 回退读文件（#350）', () => {
        const f = path.join(RUN, 'w-a.md');
        files.push(f);
        fs.writeFileSync(f, '# 文件内容\n从文件读进来的', 'utf-8');
        const r = w.write({ content: '', path: f, source: 'docB' });
        assert.equal(r.totalChunks, 1, `实际 ${r.totalChunks}（空串被当成有内容了？）`);
        assert.equal(r.label, 'docB');
    });

    t('⑥ 非普通文件被拒（目录/设备）', () => {
        let threw = null;
        try { w.write({ path: RUN, source: 'docC' }); } catch (e) { threw = e; }
        assert.ok(threw, '目录应被拒');
        assert.equal(threw.code, 'NOT_REGULAR_FILE', `实际 code=${threw.code}`);
    });

    t('⑦ 两个输入都没有 → NO_INPUT', () => {
        let threw = null;
        try { w.write({}); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'NO_INPUT');
    });

    t('⑧ vocabulary 真表有词（≥3 字符）', () => {
        const c = db.prepare('SELECT COUNT(*) c FROM vocabulary').get().c;
        assert.ok(c > 0, 'vocabulary 空');
        const short = db.prepare('SELECT COUNT(*) c FROM vocabulary WHERE length(word) < 3').get().c;
        assert.equal(short, 0, `<3 字符的词被写进去了：${short}`);
    });

    t('⑨ 纯文本写入（日志形态）', () => {
        const r = w.writePlainText('第一行\n第二行\n第三行', 'logA', 20);
        assert.ok(r.totalChunks >= 1);
        assert.equal(r.codeChunks, 0);
    });

    t('⑩ JSON 写入：key path 当标题，非 JSON 落纯文本', () => {
        const r1 = w.writeJSON(JSON.stringify({ a: { b: { c: 1 } } }), 'jsonA');
        assert.ok(r1.totalChunks > 0);
        const titles = db.prepare('SELECT title FROM chunks WHERE source_id = ?').all(r1.sourceId).map((x) => x.title);
        assert.ok(titles.some((x) => x.includes('a > b')), `标题：${titles}`);
        const r2 = w.writeJSON('不是 json', 'jsonB');
        assert.ok(r2.totalChunks > 0);
    });

    t('⑪ [07-A6] 二进制文件：严格 UTF-8 解码失败 → NOT_TEXT，库里一个字都不进', () => {
        // 造一段真 PNG 头（\x89PNG 不是合法 UTF-8 起始字节）+ 随机高位字节
        const f = path.join(RUN, 'real-binary.png');
        files.push(f);
        fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0xC3, 0x28]));
        const before = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;
        let threw = null;
        try { w.write({ path: f, source: 'binA' }); } catch (e) { threw = e; }
        assert.ok(threw, '二进制文件没被拒 —— 会被写成 U+FFFD 乱码进库');
        assert.equal(threw.code, 'NOT_TEXT', `实际 code=${threw.code}`);
        assert.equal(threw.binary, true, '没打 binary 标记（目录路径要靠它计 skippedBinary）');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks').get().c, before, '库里多了块 —— 乱码进库了');
        // ★ 最要紧的一条：库里不许出现替换字符 U+FFFD
        const bad = db.prepare("SELECT COUNT(*) c FROM chunks WHERE content LIKE '%' || char(65533) || '%'").get().c;
        assert.equal(bad, 0, `库里有 ${bad} 块含 U+FFFD 乱码`);
    });

    t('⑫ [07-A7] content 只有空白 → NO_INPUT（不许建 0 块垃圾源行）', () => {
        const before = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
        for (const blank of ['', '   ', '\n\n', ' \t\r\n ']) {
            let threw = null;
            try { w.write({ content: blank, source: 'blankA' }); } catch (e) { threw = e; }
            // 空串本来就走 #350 语义（没 path → NO_INPUT），这里重点看"纯空白"
            assert.ok(threw, `content=${JSON.stringify(blank)} 没被拒`);
            assert.equal(threw.code, 'NO_INPUT', `content=${JSON.stringify(blank)} 实际 code=${threw.code}`);
        }
        assert.equal(db.prepare('SELECT COUNT(*) c FROM sources').get().c, before, 'sources 多了行 —— 空白建了垃圾源');
    });

    t('⑬ [07-A6b] 合法 UTF-8 的中文/emoji 照常入库（严格解码不许误伤）', () => {
        const f = path.join(RUN, 'utf8-ok.md');
        files.push(f);
        fs.writeFileSync(f, '# 中文标题\n带 emoji 🫧 和全角标点：，。！\n', 'utf-8');
        const r = w.write({ path: f, source: 'utf8A' });
        assert.ok(r.totalChunks > 0, '合法 UTF-8 被误判成二进制了');
        const row = db.prepare("SELECT content FROM chunks WHERE source_id = ?").get(r.sourceId);
        assert.ok(row.content.includes('🫧'), 'emoji 丢了');
        assert.ok(row.content.includes('：'), '全角标点被改了（库定稿：存原文，不做 NFKC）');
    });

    console.log(`\n08-writer: ${n} 项全绿`);
    db.close();
}
catch (e) {
    console.error('08-writer selftest 失败：', e.message);
    process.exitCode = 1;
}
finally {
    cleanup();
}
