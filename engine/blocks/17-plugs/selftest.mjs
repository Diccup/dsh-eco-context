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
 * 17-plugs/selftest.mjs — 单跑必绿（G8：换实现不改调用方 + 对比表）
 */
import assert from 'node:assert/strict';
import { createSlots, rankRrf, rankMmr, rankProximity, SLOT_KINDS } from './index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t('① 三种槽只三种（不引入万能注册框架）', () => {
    assert.deepEqual([...SLOT_KINDS], ['tokenize', 'chunk', 'rank']);
});

t('② 默认实现齐全：rank 有 rrf/mmr/proximity', () => {
    const s = createSlots();
    const list = s.list();
    assert.deepEqual(list.rank.sort(), ['mmr', 'proximity', 'rrf']);
    assert.ok(list.tokenize.length === 0, '横切层不该自带 tokenize 实现（那在 07）');
});

t('③ 取不存在的实现 → 可读错误（列出可用）', () => {
    const s = createSlots();
    let threw = null;
    try { s.get('rank', 'nope'); } catch (e) { threw = e; }
    assert.ok(threw.message.includes('可用'), threw.message);
});

t('④ rankRrf 融合两榜且顺序符合 K=60 语义', () => {
    const a = [{ title: 'T1', source: 's' }, { title: 'T2', source: 's' }];
    const b = [{ title: 'T2', source: 's' }, { title: 'T3', source: 's' }];
    const out = rankRrf([['porter', a], ['trigram', b]], { k: 60, limit: 3 });
    // T2 在两榜都出现 → 分数最高
    assert.equal(out[0].title, 'T2', JSON.stringify(out.map((x) => x.title)));
    assert.ok(out[0].layers.length === 2, JSON.stringify(out[0].layers));
    // T1 只在第一榜第 1，T3 只在第二榜第 1 → 同分，但 T1 在前（稳定排序）
    assert.equal(out.length, 3);
});

t('⑤ 换 rank 实现：同形签名，调用方一行不改（G8）', () => {
    const inputs = [[
        ['porter', [{ title: 'A', source: 's', rank: -1, content: '一', contentType: 'prose' }]],
        ['trigram', [{ title: 'B', source: 's', rank: -1, content: '二', contentType: 'prose' }]],
    ]];
    const s = createSlots();
    const rrf = s.get('rank', 'rrf')(inputs[0], { limit: 2 });
    const prox = s.get('rank', 'proximity')(rrf, { terms: ['一'], limit: 2 });
    // ← 调用方只换了函数名，参数形状一模一样
    assert.ok(rrf.length > 0 && prox.length > 0);
    assert.ok(prox.every((r) => 'title' in r && 'source' in r));
});

t('⑥ 自注册新实现：不改 createSlots 一行', () => {
    const s = createSlots({ rank: { firstOnly: (list) => (Array.isArray(list[0]) ? list[0][1] : list).slice(0, 1) } });
    assert.ok(s.list().rank.includes('firstOnly'));
    const out = s.get('rank', 'firstOnly')([['x', [{ title: 'Z' }]]]);
    assert.equal(out.length, 1);
});

t('⑦ rankProximity：单词查询时标题命中排前（title boost 生效）', () => {
    // 注意：多词查询时 proximity 上限 ≈1.0，会压过 title 的 0.3/0.6 —— 这是 1.2.2 的
    // 既有设计（"有实测：紧邻窗口最可信"），所以这里用**单词**隔离 title 的影响。
    const results = [
        { title: '无关标题', content: '正文里有僵尸进程', contentType: 'prose', rank: -1 },
        { title: '僵尸进程判定', content: '正文别的内容', contentType: 'prose', rank: -2 },
    ];
    const out = rankProximity(results, { terms: ['僵尸'] });
    assert.equal(out[0].title, '僵尸进程判定', JSON.stringify(out.map((x) => x.title)));
});

t('⑦b rankProximity：多词紧邻的正文确实能压过标题（既有设计，不是 bug）', () => {
    const results = [
        { title: '无关标题', content: '正文里有僵尸进程', contentType: 'prose', rank: -1 },
        { title: '僵尸进程判定', content: '正文别的内容', contentType: 'prose', rank: -2 },
    ];
    const out = rankProximity(results, { terms: ['僵尸', '进程'] });
    assert.equal(out[0].title, '无关标题', '紧邻窗口应拿到 ≈1.0 的 proximity boost');
});

t('⑧ rankProximity：tier boost 让有 sessionId 的块微加权', () => {
    const a = { title: '同标题', content: '同正文', contentType: 'prose', rank: -1, sessionId: 'sess' };
    const b = { title: '同标题', content: '同正文', contentType: 'prose', rank: -1, sessionId: '' };
    const out = rankProximity([b, a], { terms: ['同正文'], tierWeight: 0.15 });
    assert.equal(out[0].sessionId, 'sess');
});

t('⑨ rankMmr：多样性（同标题的候选不会被全选）', () => {
    const cands = [
        { title: 'foo bar', rank: -1 },
        { title: 'foo bar', rank: -1 },
        { title: 'baz qux', rank: -3 },
    ];
    const out = rankMmr(cands, { lambda: 0.9, limit: 2, similarity: (x, y) => (x.title === y.title ? 1 : 0) });
    assert.ok(out.length === 2);
    assert.notEqual(out[0].title, out[1].title, 'MMR 没起到去冗余作用');
});

t('⑩ compare 产出两实现对比表（G5b 的产出形状）', () => {
    const s = createSlots();
    const inputs = [
        [['porter', [{ title: 'X', source: 's' }]], ['trigram', [{ title: 'Y', source: 's' }]]],
    ];
    const { table } = s.compare('synthetic', inputs, ['rrf'], { limit: 2 });
    assert.equal(table.length, 1);
    assert.equal(table[0].impl, 'rrf');
    assert.ok(table[0].ms >= 0);
    assert.equal(table[0].results.length, 1);
});

t('⑪ 槽不自带 impl 依赖（横切层可单测）——本文件没有 import 任何 blocks/*', () => {
    // 这条靠静态扫描在 G 门里查；这里断言 slots 纯内存可建
    const s = createSlots();
    assert.ok(s.get('rank', 'rrf'));
});

console.log(`\n17-plugs: ${n} 项全绿`);
