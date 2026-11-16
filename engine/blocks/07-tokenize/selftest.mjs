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
 * 07-tokenize/selftest.mjs — 单跑必绿
 *
 * 测什么：短语相邻性（这是 CJK 塌陷的病灶）／trigram <3 过滤／全停用词回退／
 *        布尔保留字剔除／编辑距离阈值。
 */
import assert from 'node:assert/strict';
import { STOPWORDS, porterExpr, trigramExpr, parseUnits, rankTerms, fuzzyWords, levenshtein, maxEditDistance, dedupeTokens } from './index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t('① 短语保留相邻性：foo bar 不被降级成 OR', () => {
    const e = porterExpr('"foo bar"');
    assert.equal(e, '"foo bar"', e);
});

t('② 普通多词 AND 用空格连接（FTS5 隐式 AND）', () => {
    const e = porterExpr('僵尸 进程');
    assert.equal(e, '"僵尸" "进程"');
});

t('③ OR 模式用显式 OR', () => {
    const e = porterExpr('alpha beta', 'OR');
    assert.equal(e, '"alpha" OR "beta"');
});

t('④ 停用词过滤：test update fix 全被滤掉后，回退不过滤（不许空表达式）', () => {
    const e = porterExpr('test update fix');
    assert.ok(e.length > 0 && e !== '""', `应回退，实际 ${e}`);
    assert.ok(e.includes('test'));
});

t('⑤ 部分停用词被滤掉，实质词保留', () => {
    const e = porterExpr('the config loader');
    assert.ok(e.includes('"config"'));
    assert.ok(e.includes('"loader"'));
    assert.ok(!e.includes('"the"'), e);
});

t('⑥ 布尔保留字当普通词丢弃（不当操作符）', () => {
    const units = parseUnits('foo AND bar');
    assert.deepEqual(units.map((u) => u.value), ['foo', 'bar']);
});

t('⑦ trigram <3 字符直接空表达式', () => {
    assert.equal(trigramExpr('ab'), '');
});

t('⑧ trigram 过滤 <3 字符的词，保留长词', () => {
    const e = trigramExpr('onfig configuration');
    assert.ok(e.includes('onfig'));
    assert.ok(e.includes('configuration'));
});

t('⑨ trigram 短语也保序', () => {
    const e = trigramExpr('"onfig load"');
    assert.ok(e.includes('"onfig load"'), e);
});

t('⑩ 全停用词 trigram 回退不过滤', () => {
    const e = trigramExpr('testing updates');
    assert.ok(e.length > 0, e);
});

t('⑪ rankTerms 去停用词但至少返回非空', () => {
    assert.deepEqual(rankTerms('the config'), ['config']);
    const onlyStop = rankTerms('the and');
    assert.ok(onlyStop.length > 0, '全停用词也要有词用于排序');
});

t('⑫ fuzzyWords 只取 ≥3 且非停用词', () => {
    assert.deepEqual(fuzzyWords('erro test'), ['erro']);
});

t('⑬ levenshtein 已知值', () => {
    assert.equal(levenshtein('erro', 'error'), 1);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', 'abc'), 0);
});

t('⑭ maxEditDistance 三档', () => {
    assert.equal(maxEditDistance(4), 1);
    assert.equal(maxEditDistance(10), 2);
    assert.equal(maxEditDistance(20), 3);
});

t('⑮ dedupeTokens 大小写无关去重保留首现', () => {
    assert.deepEqual(dedupeTokens(['Error', 'error', 'ERR']), ['Error', 'ERR']);
});

t('⑯ 空查询回 "" 不炸', () => {
    assert.equal(porterExpr(''), '""');
    assert.equal(trigramExpr(''), '');
});

t('⑰ 停用词表就是 102 词（与 1.2.2 store.js L20-34 完整一致，多一个少一个都会改变排序基线）', () => {
    // 实测回源：ref/current-engine/store.js 的 STOPWORDS = 102 个（文档里"88"是旧计数，已订正）
    assert.equal(STOPWORDS.size, 102, `实际 ${STOPWORDS.size}`);
});

console.log(`\n07-tokenize: ${n} 项全绿`);
