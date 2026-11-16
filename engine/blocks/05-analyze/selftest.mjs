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
 * 05-analyze/selftest.mjs — 单跑必绿（node blocks/05-analyze/selftest.mjs）
 *
 * 测什么：① 切块不超 4096 B ② 代码块不被切断 ③ 标题面包屑成链 ④ NFKC ④ 空内容不静默 0 块
 */
import assert from 'node:assert/strict';
import { chunk, chunkMarkdown, chunkPlainText, chunkJSON, normalize, foldForSearch, assertChunks, byteCappedPrefix } from './index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t('normalize 保原文：去 BOM，但**不**做 NFKC（全角标点必须原样留下）', () => {
    // ★ 2026-11-05 修正：这里原来断言 normalize('\uFEFFＡＢＣ') === 'ABC'，
    //   那正是 bug 本身 —— NFKC 会把中文全角标点压成半角，写进库的就不是原文了。
    assert.equal(normalize('\uFEFFＡＢＣ'), 'ＡＢＣ');       // BOM 去掉，全角保留
    assert.equal(normalize('冒号：结束'), '冒号：结束');      // 全角冒号不动
    assert.equal(normalize('逗号，分号；'), '逗号，分号；');
    assert.equal(normalize('a\u0000b'), 'ab');               // NUL 去掉
});

t('foldForSearch 才做 NFKC（检索归一，全角搜得到半角）', () => {
    assert.equal(foldForSearch('ＡＢＣ'), 'ABC');
    assert.equal(foldForSearch('冒号：结束'), '冒号:结束');
    assert.equal(foldForSearch('数字１２３'), '数字123');
});

t('markdown 标题栈成面包屑', () => {
    const md = ['# 一级', '内容甲', '', '## 二级', '内容乙', '', '### 三级', '内容丙'].join('\n');
    const chunks = chunkMarkdown(md);
    assert.ok(chunks.some((c) => c.title === '一级 > 二级 > 三级'), `实际标题：${chunks.map((c) => c.title)}`);
});

t('代码块不被切断（围栏内整块）', () => {
    const md = ['# 头', '```js', 'const a = 1;', 'const b = 2;', '```', '尾巴'].join('\n');
    const chunks = chunkMarkdown(md);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].hasCode, true);
    assert.ok(chunks[0].content.includes('const b = 2;'));
});

t('超巨大的块被拆且每块 ≤4096 B', () => {
    const big = ['# 大节', ...Array.from({ length: 400 }, (_, i) => `段落${i} ` + 'x'.repeat(60))].join('\n\n');
    const chunks = chunkMarkdown(big);
    assert.ok(chunks.length > 1, `应拆多块，实际 ${chunks.length}`);
    assertChunks(chunks);
});

t('纯文本：空行分节策略', () => {
    const txt = ['第一节', 'a1', '', '第二节', 'b1', '', '第三节', 'c1', '', '第四节', 'd1'].join('\n');
    const chunks = chunkPlainText(txt);
    assert.ok(chunks.length >= 3, `应成多节，实际 ${chunks.length}`);
});

t('纯文本：超长单行按字节+空白断点切，不劈中文', () => {
    const line = '僵尸进程判定'.repeat(1400); // ~10KB 无空格
    const chunks = chunkPlainText(line, 20);
    assert.ok(chunks.length > 1);
    assertChunks(chunks);
    // 每块最后必须是完整字符（无 U+FFFD 替换符）
    for (const c of chunks) assert.ok(!c.content.includes('\uFFFD'));
});

t('JSON：key path 当标题、数组按体积批处理', () => {
    const obj = { config: { db: { path: 'x.db', wal: true } }, list: Array.from({ length: 40 }, (_, i) => ({ id: i, v: 'y'.repeat(200) })) };
    const chunks = chunkJSON(JSON.stringify(obj));
    assert.ok(chunks.some((c) => c.title.includes('config > db')));
    assert.ok(chunks.some((c) => /list > /i.test(c.title)));
    assertChunks(chunks);
});

t('非 JSON 落到纯文本分块（不抛）', () => {
    const chunks = chunkJSON('这不是 json');
    assert.ok(chunks.length > 0);
});

t('空内容不静默 0 块，有内容至少一块', () => {
    assert.deepEqual(chunk('', 'markdown'), []);
    assert.equal(chunk('一句话', 'markdown').length, 1);
});

t('byteCappedPrefix 不劈 emoji/CJK', () => {
    const s = '僵尸🧟🧟🧟';
    const p = byteCappedPrefix(s, 6); // 2 汉字(6B) 刚好
    assert.equal(p, '僵尸');
    const q = byteCappedPrefix('🧟🧟', 10); // 4B+4B=8B ≤10
    assert.equal(q, '🧟🧟');
});

console.log(`\n05-analyze: ${n} 项全绿`);
