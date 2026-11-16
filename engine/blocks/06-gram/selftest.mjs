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
 * 06-gram/selftest.mjs — gram 22 项自验（G2b 的核心）
 *
 * 测什么：索引侧折叠 / 查询侧不折叠 / 单字双字同列 / 跨 run 不拼假双字 /
 *        布尔语义直通 / >8 字中文（这是 ours/cjk.js 的真实 bug，必须修好）
 */
import assert from 'node:assert/strict';
import {
    deSpaceHan, scriptRuns, runGrams, buildScriptNgrams, analyzeScriptQuery,
    gramMatchExpr, buildMatch, isPureScript, isScriptChar, SCRIPT_BOUNDARY,
} from './index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

// ── 索引侧 ──
t('① 索引侧折叠汉字间水平空白：僵 尸 → 僵尸', () => {
    assert.equal(deSpaceHan('僵 尸 进 程'), '僵尸进程');
});

t('② 索引侧不折换行', () => {
    assert.equal(deSpaceHan('僵\n尸'), '僵\n尸');
});

t('③ 多空格（三空格真库里 15,846 处）也折', () => {
    assert.equal(deSpaceHan('僵   尸'), '僵尸');
});

t('④ runGrams 单字 run 原样返回', () => {
    assert.deepEqual(runGrams(['僵']), ['僵']);
});

t('⑤ runGrams 多字 run 出全部相邻双字', () => {
    assert.deepEqual(runGrams(['僵', '尸', '进', '程']), ['僵尸', '尸进', '进程']);
});

t('⑥ scriptRuns 把 ASCII 排除在 run 外', () => {
    const runs = scriptRuns('僵尸 WAL 判定');
    assert.deepEqual(runs.map((r) => r.join('')), ['僵尸', '判定']);
});

t('⑦ 单字与双字同列（只存双字时单字查询会 0 命中）', () => {
    const col = buildScriptNgrams('僵尸进程');
    const terms = col.split(' ');
    assert.ok(terms.includes('僵'), `缺单字：${col}`);
    assert.ok(terms.includes('僵尸'), `缺双字：${col}`);
});

t('⑧ 跨 run 不拼假双字：run 之间有边界哨兵', () => {
    const col = buildScriptNgrams('僵尸', '进程');
    assert.ok(col.includes(SCRIPT_BOUNDARY), col);
    assert.ok(!col.split(SCRIPT_BOUNDARY).join('|').includes('尸进'), `出现了跨 run 假双字：${col}`);
});

t('⑨ 同一文本内重复 run 去重（标点分隔的两个相同 run 只出一组）', () => {
    // 注意：去重作用域 = 单次 buildScriptNgrams 的每个入参文本（与 ref 实现一致）
    const col = buildScriptNgrams('僵尸，。僵尸');
    assert.equal(col.split(SCRIPT_BOUNDARY).length, 1, `应只有一组：${col}`);
    assert.ok(col.startsWith('僵 尸 僵尸'), col);
});

t('⑩ NFKC：全角字母归一', () => {
    const col = buildScriptNgrams('僵尸ＷＡＬ');
    assert.equal(col.includes('Ｗ'), false);
});

t('⑪ 空输入不炸', () => {
    assert.equal(buildScriptNgrams(), '');
    assert.equal(deSpaceHan(''), '');
    assert.deepEqual(scriptRuns(''), []);
});

t('⑫ buildScriptNgrams 多参数拼接', () => {
    const col = buildScriptNgrams('僵尸', '进程');
    assert.ok(col.includes('僵尸'));
    assert.ok(col.includes('进程'));
});

// ── 查询侧（关键：绝不折叠） ──
t('⑬ 查询侧不折叠空白：僵尸 进程 ≠ 僵尸进程', () => {
    const { gram_phrases } = analyzeScriptQuery('僵尸 进程');
    assert.deepEqual(gram_phrases, [['僵尸'], ['进程']], JSON.stringify(gram_phrases));
});

t('⑭ 查询侧纯 CJK 只进 gram 通道', () => {
    const r = analyzeScriptQuery('僵尸进程');
    assert.equal(r.word_text, null);
    assert.deepEqual(r.gram_phrases, [['僵尸', '尸进', '进程']]);
});

t('⑮ 含引号 → 整串交回词解析器（布尔语义直通）', () => {
    const r = analyzeScriptQuery('"僵尸 进程"');
    assert.equal(r.word_text, '"僵尸 进程"');
    assert.deepEqual(r.gram_phrases, []);
});

t('⑯ 显式 OR → 整串直通', () => {
    const r = analyzeScriptQuery('僵尸 OR 进程');
    assert.equal(r.word_text, '僵尸 OR 进程');
});

t('⑰ 中英混排：僵尸WAL 拆成 gram（僵尸）+ 词通道（WAL）', () => {
    const r = analyzeScriptQuery('僵尸WAL');
    // ★ 混排 token 必须拆开：CJK 段进 gram，ASCII 段进词通道。
    //   原实现把整串塞进词通道，导致超长混排短语永远匹配不到（T-2 实测 0/3）。
    assert.equal(r.word_text, 'WAL', JSON.stringify(r));
    assert.ok(r.gram_phrases.length > 0, 'CJK 段没进 gram');
});

t('⑱ 短 run（≤4 双字）走整短语，保精度', () => {
    const expr = gramMatchExpr([['僵尸', '尸进', '进程']]);
    assert.equal(expr, 'script_ngrams: ("僵尸 尸进 进程")', expr);
});

t('⑲ 多组 gram 在列内 AND（一次列过滤）；长 run 用 3 双字窗口 OR', () => {
    const multi = gramMatchExpr([['僵尸'], ['进程']]);
    assert.equal(multi, 'script_ngrams: ("僵尸" AND "进程")');
    assert.equal((multi.match(/script_ngrams:/g) ?? []).length, 1, '只应出现一次列过滤');
    const long = ['内存', '存泄', '泄漏', '漏排', '排查', '查方', '方法'];
    const expr = gramMatchExpr([long]);
    assert.ok(expr.includes(' OR '), '长 run 应用窗口 OR');
    assert.ok(expr.includes('"内存 存泄 泄漏"'), expr);   // 首窗口
    assert.ok(expr.includes('"排查 查方 方法"'), expr);   // 尾窗口
});

t('⑳ buildMatch 词条件 + gram 条件 AND', () => {
    const expr = buildMatch('僵尸 WAL');
    assert.ok(expr.includes('script_ngrams:'));
    assert.ok(expr.includes('AND'));
});

// ── 中文 >8 字（ours/cjk.js 的 8 字上限真 bug） ──
t('㉑ >8 字中文查询能产出完整 gram（无 8 字截断）', () => {
    const long = '僵尸进程判定与内存泄漏排查方法';
    assert.ok(long.length > 8);
    const { gram_phrases } = analyzeScriptQuery(long);
    const pairs = gram_phrases.flat();
    // 20 字 run 应产出 19 个相邻双字，不是被截成 8 字的 7 个
    assert.equal(pairs.length, long.length - 1, `双字数量 ${pairs.length} ≠ ${long.length - 1}`);
    assert.ok(pairs.includes('排查'), '缺「排查」');
    assert.ok(pairs.includes('方法'), '缺「方法」');
    assert.ok(pairs.includes('泄漏'), '缺「泄漏」');
});

t('㉒ isPureScript 与 isScriptChar', () => {
    assert.equal(isPureScript('僵尸进程'), true);
    assert.equal(isPureScript('僵尸 WAL'), false);
    assert.equal(isScriptChar('僵'), true);
    assert.equal(isScriptChar('a'), false);
});

console.log(`\n06-gram: ${n} 项全绿`);
