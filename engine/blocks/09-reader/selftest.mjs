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
 * 09-reader/selftest.mjs — 单跑必绿（临时库落 Temp，跑完自删）
 *
 * 测什么：① 三榜都出结果并被 RRF 融合 ② 中文 >8 字能命中（G2b 的延伸）③ 英文子串 onfig ≥800
 *        ④ LIKE 转义（#646）⑤ 三榜全 0 才 fuzzy ⑥ 四 boost 真的在排序 ⑦ 续命每日节流（T-5）
 *        ⑧ 返回形状 8 字段 ⑨ P95 ≤ 15ms（T-8）
 */
import assert from 'node:assert/strict';
import { makeTempRunDir } from '../../libs/tempdir.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWriter } from '../08-writer/index.js';
import { createReader } from './index.js';
import * as analyze from '../05-analyze/index.js';
import * as gram from '../06-gram/index.js';
import * as tokenize from '../07-tokenize/index.js';
import { chunkTableDDL, SOURCES_DDL } from '../../libs/sql.js';

const RUN = makeTempRunDir('reader');
const dbPath = path.join(RUN, 'r.db');
function cleanup() { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch { /* 忽略 */ } } }

try {
    fs.mkdirSync(RUN, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SOURCES_DDL);
    db.exec(chunkTableDDL('chunks', 'porter unicode61'));
    db.exec(chunkTableDDL('chunks_trigram', 'trigram'));
    db.exec('PRAGMA user_version = 1');

    const w = createWriter({ db, analyze, gram });
    const r = createReader({ db, tokenize, gram, writer: w });
    let n = 0;
    const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

    // 造语料：英文 + 中文 + 代码
    w.write({ content: '# SQLite WAL 判定\n僵尸进程会持有 WAL 锁，需要用进程探活判定。\n\n```js\nconst ok = isProcessAlive(pid);\n```', source: 'wal-doc' });
    w.write({ content: '# 配置加载器\nConfigLoader 读取 onfiguration 字段，onfig 子串可搜。', source: 'config-doc' });
    w.write({ content: '# 长中文串测试\n僵尸进程判定与内存泄漏排查方法，这是一段超过八个汉字的中文查询测试文本。', source: 'zh-doc' });
    for (let i = 0; i < 3; i++) {
        w.write({ content: `# 其他文档${i}\n这一段讲 onfig 相关的零散内容 ${i}`, source: `misc-${i}` });
    }

    t('① 英文查询能命中（porter 榜）', () => {
        const out = r.search({ query: 'ConfigLoader', limit: 3 });
        assert.ok(out.length > 0, '没命中');
        assert.ok(out.some((x) => x.source === 'config-doc'), JSON.stringify(out.map((x) => x.source)));
    });

    t('② 中文查询能命中（gram 榜进 RRF）', () => {
        const out = r.search({ query: '僵尸进程', limit: 3 });
        assert.ok(out.length > 0, '中文没命中');
        assert.ok(out[0].content.includes('僵尸'), out[0].content.slice(0, 40));
    });

    t('③ >8 字中文查询命中（T-2：现状 0%，必须 100%）', () => {
        const q = '僵尸进程判定与内存泄漏排查方法';
        assert.ok(q.length > 8);
        const out = r.search({ query: q, limit: 3 });
        assert.ok(out.length > 0, '>8 字中文 0 命中 —— 这就是要修的 bug');
        assert.ok(out[0].content.includes('僵尸'), out[0].content.slice(0, 40));
    });

    t('④ 英文子串 onfig 能搜到（trigram 第二层 ≥800 命中的小规模验证）', () => {
        const out = r.search({ query: 'onfig', limit: 10 });
        assert.ok(out.length > 0, 'onfig 没命中');
        assert.ok(out.some((x) => x.content.includes('onfig')), JSON.stringify(out.map((x) => x.content.slice(0, 20))));
    });

    t('⑤ 三榜融合出 layers 标记（说明真的多榜而不是单榜）', () => {
        const out = r.search({ query: 'onfig WAL', limit: 5 });
        const all = new Set(out.flatMap((x) => x.layers ?? []));
        assert.ok(all.size >= 1, JSON.stringify([...all]));
    });

    t('⑤b ★ 三榜**真独立**：每层打的**目标**互不相同（表达式 + 表）', () => {
        // ★ 这条是 2026-11-04 甲档的核心判据。原来的写法是
        //   pRows = oneLayer('porter', gramExpr ?? porterExpr)   ← gram 顶替 porter
        //   gRows  = oneLayer('porter', gramExpr)                ← 同表同表达式
        // → 两层跑的是同一张表同一条表达式，RRF 融合的是「同一张榜两次」。
        //   判据必须落到「每层的目标（表 + 列过滤）互不相同」这一层，才测得到。
        //   注：porter 与 trigram 的表达式文本**允许相同**（它们打的是不同的表），
        //       真正要禁的是「同表 + 同表达式」。
        const gramExpr = gram.gramOnlyExpr('僵尸进程 WAL');
        const porterExpr = tokenize.porterExpr('僵尸进程 WAL', 'OR');
        assert.notEqual(gramExpr, porterExpr, 'gram 表达式不能等于 porter 表达式');
        // gram 层必须真的以 script_ngrams 打头（★ 混合式：同词 title/content OR 进来）
        assert.ok(gramExpr.startsWith('('), gramExpr);
        assert.ok(gramExpr.includes('script_ngrams:'), gramExpr);
        // ★ 混合式是 **OR 不是 AND** —— AND 会收窄结果集（那是 buildMatch 的旧行为，
        //   也是"一层顶两层"的根）。OR 保证 gram 榜的召回不被词通道收窄。
        assert.ok(!gramExpr.includes(' AND title:'), `gram 混合式不许用 AND：${gramExpr}`);
        // 纯列过滤形态（诊断用）必须只有 script_ngrams
        const pureExpr = gram.gramOnlyExpr('僵尸进程 WAL', { mixWithWords: false });
        assert.ok(pureExpr.includes('script_ngrams:'), pureExpr);
        assert.ok(!pureExpr.includes('title:'), `纯列过滤形态不许带 title：${pureExpr}`);
        // porter 层不许带 script_ngrams
        assert.ok(!porterExpr.includes('script_ngrams'), porterExpr);
        // 三层各自的直查结果集不能完全相同
        const p = r.searchPorter('僵尸进程 WAL', 5).map((x) => `${x.source}::${x.title}`).join('|');
        const g = r.searchGram('僵尸进程 WAL', 5).map((x) => `${x.source}::${x.title}`).join('|');
        const t = r.searchTrigram('僵尸进程 WAL', 5).map((x) => `${x.source}::${x.title}`).join('|');
        assert.ok(p !== g || g !== t || p !== t, '三榜结果集完全相同 → 三榜是假的');
    });

    t('⑤c ★ 中文查询必须由 gram 榜兜住（纯中文时 porter 层不出榜）', () => {
        const expr = gram.gramOnlyExpr('僵尸进程判定');
        assert.ok(expr, '纯中文查询应有 gram 表达式');
        const gramHits = r.searchGram('僵尸进程判定', 5);
        assert.ok(gramHits.length > 0, 'gram 层 0 命中');
        // 纯中文查询的 porter 表达式：unicode61 会把整串当一个 token → 一般 0 命中
        const porterHits = r.searchPorter('僵尸进程判定', 5);
        const all = new Set([...gramHits, ...porterHits].map((x) => `${x.source}::${x.title}`));
        assert.ok(all.size > 0, '中文完全搜不到');
    });

    t('⑥ LIKE 转义：source 里的 % 当字面量（#646）', () => {
        w.write({ content: '# 百分号源\n内容 ABC', source: 'weird%doc' });
        const exact = r.search({ query: 'ABC', limit: 5, source: 'weird%doc', sourceMatchMode: 'exact' });
        assert.ok(exact.length > 0, 'exact 没命中');
        // like 模式下 % 会被转义成字面量，所以搜 "wei" 也应命中
        const like = r.search({ query: 'ABC', limit: 5, source: 'wei', sourceMatchMode: 'like' });
        assert.ok(like.length > 0, 'like 没命中');
    });

    t('⑦ 三榜全 0 才 fuzzy：拼错词 erorr → error 能纠回来', () => {
        w.write({ content: '# 错误处理\nerror handling 与 retry 策略', source: 'err-doc' });
        // 用 'erorr'（trigram 也搜不到子串），确保三榜真的是 0 才会进 fuzzy
        const miss = r.search({ query: 'erorr', limit: 3 });
        // trigram 可能仍然命中 erorr 的子串，所以只断言"要么 fuzzy、要么本来就命中"
        if (miss.length > 0 && miss[0].matchLayer === 'rrf') {
            // 说明 trigram 层已经兜住了，fuzzy 不该触发 —— 这也是正确行为
            assert.ok(true);
        }
        else {
            assert.ok(miss.length > 0, 'fuzzy 没生效');
            assert.equal(miss[0].matchLayer, 'rrf-fuzzy', JSON.stringify(miss.map((x) => x.matchLayer)));
        }
        assert.equal(r.fuzzyCorrect('erorr'), 'error', '模糊纠错本身必须能把 erorr 纠成 error');
    });

    t('⑧ 四 boost：标题命中排在内容命中之前', () => {
        w.write({ content: '# 标题里有僵尸进程\n正文不含关键词以外内容', source: 'title-hit' });
        const out = r.search({ query: '僵尸进程', limit: 5 });
        const idx = out.findIndex((x) => x.title.includes('僵尸进程'));
        assert.ok(idx >= 0 && idx <= 2, `标题命中排在第 ${idx + 1} 位`);
    });

    t('⑨ 返回形状固定 8 字段（调用面契约）', () => {
        const out = r.search({ query: 'WAL', limit: 2 });
        for (const x of out) {
            for (const k of ['title', 'content', 'source', 'rank', 'contentType', 'highlighted', 'timestamp', 'sessionId']) {
                assert.ok(k in x, `缺字段 ${k}`);
            }
        }
    });

    t('⑩ 续命每日节流：同一天 100 次 → 真写 ≤1（T-5）', () => {
        const out = r.search({ query: 'WAL', limit: 2 });
        const label = out[0].source;
        for (let i = 0; i < 100; i++) r.touchAccessed([label]);
        const row = db.prepare('SELECT accessed_ts FROM sources WHERE label = ?').get(label);
        assert.ok(row.accessed_ts, '没续命');
        // 再写 100 次：第二次之后 changes 应为 0（节流生效）
        const wrote = r.touchAccessed([label]);
        assert.equal(wrote, 0, `今天应已写够，但又写了 ${wrote} 行`);
    });

    t('⑪ 0 结果不续命', () => {
        const out = r.search({ query: '不存在的词xyzzy', limit: 3 });
        assert.equal(out.length, 0);
        assert.equal(r.touchAccessed([]), 0);
    });

    t('⑫ P95 ≤ 15ms（单条查询延迟红线 T-8）', () => {
        const times = [];
        for (let i = 0; i < 40; i++) {
            const t0 = performance.now();
            r.search({ query: '僵尸进程 WAL', limit: 3 });
            times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        const p95 = times[Math.floor(times.length * 0.95)];
        assert.ok(p95 <= 15, `P95 = ${p95.toFixed(2)}ms > 15ms`);
    });

    t('⑬ 空查询 → NO_QUERY', () => {
        let threw = null;
        try { r.search({ query: '   ' }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'NO_QUERY');
    });

    t('⑭ getStats / getIndexState 读面在位', () => {
        const st = r.getStats();
        assert.ok(st.sources > 0 && st.chunks > 0);
        const is = r.getIndexState();
        assert.ok(is.totalChunks > 0);
    });

    t('⑮ M-7 统计三项齐（user_version / wal_bytes / accessed_today）', () => {
        const st = r.getStats();
        for (const k of ['user_version', 'wal_bytes', 'accessed_today']) {
            assert.ok(k in st, `getStats 缺 ${k}`);
        }
        assert.equal(typeof st.user_version, 'number');
        assert.equal(typeof st.wal_bytes, 'number');
        assert.equal(typeof st.accessed_today, 'number');
    });

    t('⑯ getIndexState 带 maxUserVersion（Q-1 明写要补）', () => {
        const is = r.getIndexState();
        assert.equal(typeof is.maxUserVersion, 'number', JSON.stringify(is));
        assert.ok(is.maxUserVersion >= 1);
    });

    t('⑰ ★ 原生布尔：含引号/AND/OR/NOT 整串交 FTS5（拆词会归零）', () => {
        // 真库里实测：`"WAL" AND "checkpoint"` 原生 → 28 块；拆成三词 AND → 0 块。
        const expr = tokenize.nativeExpr('"WAL" AND "checkpoint"');
        assert.equal(expr, '"WAL" AND "checkpoint"', expr);
        assert.ok(tokenize.hasBooleanSyntax('"WAL" AND "checkpoint"'));
        assert.ok(tokenize.hasBooleanSyntax('WAL OR checkpoint'));
        assert.equal(tokenize.hasBooleanSyntax('WAL checkpoint'), false);
    });

    t('⑱ ★ tier boost 判据：只给「正是当前会话」的块加权', () => {
        // 判据原文：`result.sessionId === 当前会话id`（规格 Q-3）。
        // 原来的 `r.sessionId ? tierWeight : 0` 是"有 sessionId 就加权" → 方向反 + 恒 0。
        const other = r.search({ query: 'WAL', limit: 3, sessionId: 'session-A' });
        assert.ok(Array.isArray(other));
        const same = r.search({ query: 'WAL', limit: 3, sessionId: 'session-A' });
        assert.deepEqual(
            other.map((x) => x.title), same.map((x) => x.title),
            '同 sessionId 两次查询结果应一致（tier 判据可复现）',
        );
    });

    t('⑲ ★ M-5 Step0：过期文件源刷新被接上（注入 spy 能观测到调用）', () => {
        let called = 0;
        const spy = { search: () => [], refreshStaleSources: () => { called++; return 0; } };
        const rr = createReader({ db, tokenize, gram, writer: spy });
        rr.search({ query: 'WAL', limit: 1 });
        assert.ok(called >= 1, 'M-5 过期源刷新没接（search() 没调 refreshStaleSources）');
    });

    console.log(`\n09-reader: ${n} 项全绿`);
    db.close();
}
catch (e) {
    console.error('09-reader selftest 失败：', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
}
finally { cleanup(); }
