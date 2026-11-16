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
 * 15-hooks/selftest.mjs — 单跑必绿
 *
 * ★★ 2026-11-14（项目 07）：删掉原 ⑦（onWorkStart 返回 hints）与 ⑨（无 recall 时安全返回空）——
 *   道 A 退役，`onWorkStart` 整件摘除。补一条 ⑦ 专门守"不许复活"。
 */
import assert from 'node:assert/strict';
import { createHooks, LAYERS } from './index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

const writerCalls = [];
const fakeWriter = {
    writePlainText: (text, label, lines, attr) => {
        writerCalls.push({ text, label, attr });
        return { sourceId: writerCalls.length, label, totalChunks: 1, codeChunks: 0 };
    },
};
const fakeRecall = {
    recallCompacted: (prompt, card) => ({ text: `[回放] ${card}`, bytes: 10, blocks: [{ source: 's', title: 't', identity: 's::t' }], pointers: [], hasRecapCard: Boolean(card) }),
};
const hooks = createHooks({ writer: fakeWriter, recall: fakeRecall });

t('① 归档三层只三种（字面量与 1.2.2 precompact 同义）', () => {
    assert.deepEqual([...LAYERS], ['constraint', 'finding', 'narrative']);
});

t('② archiveBatch：label 带层与批次号（同批次=覆盖）', () => {
    const r = hooks.archiveBatch({ batchLabel: 'b42', text: '文本', layer: 'constraint' });
    assert.equal(r.label, 'compact:constraint:b42');
    assert.equal(r.layer, 'constraint');
    const call = writerCalls[writerCalls.length - 1];
    assert.equal(call.label, 'compact:constraint:b42');
});

t('③ 非法 layer 落回 narrative（不报错）', () => {
    const r = hooks.archiveBatch({ batchLabel: 'b1', text: 'x', layer: 'weird' });
    assert.equal(r.layer, 'narrative');
});

t('④ 缺 batchLabel → 可读错误', () => {
    let threw = null;
    try { hooks.archiveBatch({ text: 'x' }); } catch (e) { threw = e; }
    assert.equal(threw?.code, 'NO_INPUT');
});

t('⑤ onCompacted：先归档再出道 B（两件都做）', () => {
    const r = hooks.onCompacted({ batchLabel: 'c1', recapCard: '小卡', prompt: '僵尸进程', text: '归档正文' });
    assert.ok(r.archived, '没归档');
    assert.ok(r.playback, '没出道 B');
    assert.equal(r.playback.hasRecapCard, true);
    assert.deepEqual(r.errors, []);
});

t('⑥ 道 B 失败不阻断归档（errors 记但不抛）', () => {
    const h2 = createHooks({ writer: fakeWriter, recall: { recallCompacted: () => { throw new Error('回放炸了'); } } });
    const r = h2.onCompacted({ batchLabel: 'c2', recapCard: '卡', prompt: 'x', text: '正文' });
    assert.ok(r.archived, '归档被回放失败拖累了');
    assert.ok(r.errors.some((e) => e.includes('recallCompacted')));
});

t('⑦ ★ 道 A 已退役：onWorkStart 不许存在（不是返回空，是没有这个方法）', () => {
    // ★ 判据是"能力不存在"。留一个恒返回 `{hints:[]}` 的方法 = 下一个人会以为道 A 还活着。
    assert.equal(typeof hooks.onWorkStart, 'undefined', 'onWorkStart 还在 —— 道 A 没摘干净');
    // 道 B 的触发点必须还在（删道 A 不许顺手删道 B）
    assert.equal(typeof hooks.onCompacted, 'function', 'onCompacted 没了 —— 道 B 被误删');
});

t('⑧ classifyLayer：约束句 → constraint，实测句 → finding，其余 → narrative', () => {
    assert.equal(hooks.classifyLayer('必须先把 accessed_ts 加上'), 'constraint');
    assert.equal(hooks.classifyLayer('实测下来写放大 2.82×'), 'finding');
    assert.equal(hooks.classifyLayer('今天先改了日志'), 'narrative');
});

t('⑨ 没有 recall 时 onCompacted 仍归档、只是不出道 B（D1 独立跑）', () => {
    const h3 = createHooks({ writer: fakeWriter, recall: null });
    const r = h3.onCompacted({ batchLabel: 'c3', recapCard: '卡', prompt: 'x', text: '正文' });
    assert.ok(r.archived, '没有 recall 就连归档也不做了 —— 归档不该依赖道 B');
    assert.equal(r.playback, null, '没有 recall 却出了 playback');
});

t('⑩ 没有 writer 时 archiveBatch 立刻报错（显式，不静默）', () => {
    const h4 = createHooks({ recall: fakeRecall });
    let threw = null;
    try { h4.archiveBatch({ batchLabel: 'x', text: 'y' }); } catch (e) { threw = e; }
    assert.ok(threw.message.includes('缺 writer'));
});

console.log(`\n15-hooks: ${n} 项全绿`);
