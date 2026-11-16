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
 * 10-recall/selftest.mjs — 单跑必绿
 *
 * 测什么：① 道 B 必含 recap 卡 ② 道 B ≤2 整块 ③ 道 B 自己重复回放同一块被 seenB 挡
 *        ④ 席位制（长久库 ≤2 席先占）⑤ 空 prompt 的降级
 *        ⑥ **道 A 已退役**：`recallHints` 不再存在（不是"返回空"，是**没有这个方法**）
 *
 * ★★ 2026-11-14（项目 07）：原 ① ② ③ ⑥ ⑨ ⑪（全是道 A 用例）已删除。
 *   道 A 全链退役，`recallHints` / `seenA` / `hintShownCount` / `HINT_MAX_BYTES` 全部不存在。
 *   门项从 11 条降到 6 条 —— **这是删功能，不是丢用例**：每一条删掉的用例都对应一个
 *   本轮主动摘除的能力，删它们本身就是验收（下面 ⑥ 专门守"不许复活"）。
 */
import assert from 'node:assert/strict';
import { createRecall } from './index.js';

// ── 假 reader / memory（本块只测"选哪几条 + 怎么渲染"，不测底层检索） ──
function fakeReader(results) {
    return { search: ({ query, limit = 3 }) => results.slice(0, limit) };
}
const memoryRows = [
    { id: 1, title: '僵尸进程会持有 WAL 锁', category: '踩坑/僵尸进程', label: 'wal-doc', content: '正文A很长的内容……' },
    { id: 2, title: '僵尸进程判定要用进程探活', category: '踩坑/僵尸进程', label: 'wal-doc2', content: '正文B' },
    { id: 3, title: '完全无关的结论', category: '结论/其他', label: 'other', content: '正文C' },
];
const fakeMemory = {
    list: ({ limit = 100 } = {}) => memoryRows.slice(0, limit),
    get: (id) => memoryRows.find((r) => r.id === id) ?? null,
};
const tempResults = [
    { title: '僵尸进程判定与内存泄漏排查', content: '块内容一'.repeat(50), source: 'temp-a', rank: -1, contentType: 'prose', highlighted: '', sessionId: '' },
    { title: 'WAL 锁的持有者', content: '块内容二'.repeat(50), source: 'temp-b', rank: -2, contentType: 'prose', highlighted: '', sessionId: '' },
    { title: '第三块', content: '块内容三'.repeat(50), source: 'temp-c', rank: -3, contentType: 'prose', highlighted: '', sessionId: '' },
];

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

const rec = createRecall({ reader: fakeReader(tempResults), memory: fakeMemory });

t('① 道 B 必含 recap 卡（压缩器那张几十字小卡）', () => {
    const r = rec.recallCompacted('僵尸进程判定', '刚才修了 WAL 判定的启发式，改成先开库读 MAX(COALESCE(...))。');
    assert.ok(r.hasRecapCard, '没带 recap 卡');
    assert.ok(r.text.includes('压缩回放'));
    assert.ok(r.text.includes('MAX(COALESCE'));
});

t('② 道 B ≤2 整块 + 指针，总量 ~2048B 内', () => {
    const r = rec.recallCompacted('僵尸进程判定', '小卡');
    assert.ok(r.blocks.length <= 2, `带了 ${r.blocks.length} 块`);
    assert.ok(r.bytes <= 2048, `bytes=${r.bytes}`);
    assert.ok(r.pointers.length > 0, '没给指针');
});

t('③ 道 B 自己重复回放同一块会被 seenB 挡住', () => {
    rec._reset();
    const b1 = rec.recallCompacted('僵尸进程判定', '卡1');
    const b2 = rec.recallCompacted('僵尸进程判定', '卡2');
    assert.ok(b2.blocks.length <= b1.blocks.length, `b1=${b1.blocks.length} b2=${b2.blocks.length}`);
    const overlap = b2.blocks.filter((x) => b1.blocks.some((y) => y.identity === x.identity));
    assert.equal(overlap.length, 0, `重复推了：${JSON.stringify(overlap)}`);
});

t('④ 席位制：长久库 ≤2 席先占，其余由临时库补', () => {
    const merged = rec.mergeWithMemory(tempResults, memoryRows, { memorySeats: 2 });
    assert.equal(merged.filter((x) => x.store === 'memory').length, 2);
    assert.ok(merged.filter((x) => x.store === 'temp').length >= 1);
    assert.equal(merged[0].store, 'memory', '长久库应排前面');
    assert.equal(merged[0].title, memoryRows[0].title);
});

t('⑤ 空 prompt 的道 B 仍给 recap 卡', () => {
    const r = rec.recallCompacted('', '只有小卡');
    assert.ok(r.hasRecapCard);
    assert.ok(r.bytes > 0);
    assert.equal(r.blocks.length, 0);
});

t('⑥ ★ 道 A 已退役：recallHints / seenA / hintShownCount / HINT_MAX_BYTES 一个都不许在', () => {
    // ★ 判据是"能力不存在"，不是"返回空" —— 返回空说明它还活着，只是不干活。
    assert.equal(typeof rec.recallHints, 'undefined', 'recallHints 还在 —— 道 A 没摘干净（下一个人会以为还能推）');
    const st = rec._state();
    assert.equal(typeof st.seenA, 'undefined', `_state() 还报 seenA=${st.seenA} —— 留一个恒 0 的死数就是撒谎`);
    assert.equal(typeof st.hintShownCount, 'undefined', '_state() 还报 hintShownCount');
    assert.equal(typeof rec._limits.HINT_MAX_BYTES, 'undefined', '_limits 还报 HINT_MAX_BYTES');
    // 道 B 的部分必须还在（删道 A 不许顺手删道 B）
    assert.equal(typeof st.seenB, 'number', 'seenB 没了 —— 删道 A 时把道 B 的池也删了');
    assert.equal(typeof rec.recallCompacted, 'function', 'recallCompacted 没了 —— 道 B 被误删');
    assert.ok(rec._limits.RECAP_MAX_BYTES > 0, '_limits.RECAP_MAX_BYTES 没了');
});

console.log(`\n10-recall: ${n} 项全绿`);
