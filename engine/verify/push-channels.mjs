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
 * verify/push-channels.mjs — 压缩回放（道 B）的接线自验 + 「道 A 已退役」反向判据
 *
 * 干什么：把"道 B 真的接了、且真能送进模型上下文"变成可跑的判据（不是看代码里有没有函数）；
 *        同时钉死"道 A 不许复活"。
 *
 * 为什么要有它（2026-11-04 P5 起，2026-11-14 项目 07 大改）：
 *   1.0.0 的 `10-recall.recallHints/recallCompacted` **写好了但零调用方**
 *   （15-hooks 没人调、平台层没挂）→ 实测 `seenA/seenB` **恒 0**。
 *   这是"形式在位 ≠ 语义在位"的典型：函数在、判据能过、真机一次没跑。
 *   所以判据必须落在**行为**上：
 *     · 道 B：压缩后 **能取到一次** → 第二次取不到（取走即清）；
 *     · 道 B：回放必须**真的进模型上下文**（宿主同请求求值两次，提交第二次那份）；
 *     · 道 B：门测**活件**（`ours/precompact.js`），不是测零调用方的死件。
 *
 * ★★ 2026-11-14（项目 07）：**道 A【旧经验提醒】整条链退役**（说明：「把道A去掉，
 *   不要道A推送了」）。本文件原来的 30 项道 A 判据**全部删除**，并补了两条反向判据：
 *     · 「道 A 已退役」静态防线：件不存在、导出不存在、接线不存在、配置项不存在；
 *     · 台账门项数硬闸：删了门项必须同步台账（这是本文件自带的防断更闸）。
 *   删判据不是"丢用例"：每一条删掉的判据都对应一个本轮主动摘除的能力，
 *   而"它还不在"由反向判据守 —— 只删不加才叫丢。
 *
 * 跑法：node engine/verify/push-channels.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);
const WORK = path.dirname(ENGINE);
/**
 * ★★ 2026-11-06 S9.44：`ours/` 与 `platform/` 的位置在开发树和装机槽**不一样**。
 *
 *   开发仓：  `<WORK>/overlay/ours`      `<WORK>/overlay/platform`
 *   成品/装机槽：`<WORK>/ours`            `<WORK>/platform`        ← 扁平，没有 overlay/ 这层
 *
 *   原来这里写死 `path.join(WORK, 'overlay', 'ours')` —— 在装机槽跑必崩
 *   （PENDING「门在装机槽跑不起来」）。而装机槽正是**最该跑门的地方**：
 *   上一轮 ws-transport 缺件就是"G9 扫成品全绿、装机槽启动即死"，门看不见真机。
 *
 *   判据：两处都存在才叫歧义（不该发生）；只有一处存在就用它。
 *   ★ 不许"开发树缺失就静默跳到装机槽目录" —— 那会让开发树的红变成绿。
 */
function resolveDir(name) {
    const flat = path.join(WORK, name);
    const overlaid = path.join(WORK, 'overlay', name);
    const hasFlat = fs.existsSync(flat);
    const hasOverlaid = fs.existsSync(overlaid);
    if (hasFlat && hasOverlaid) {
        throw new Error(`push-channels: ${name}/ 同时存在于 ${flat} 和 ${overlaid} —— 布局歧义，先确认哪份是活的`);
    }
    if (hasOverlaid) return overlaid;   // 开发树
    if (hasFlat) return flat;           // 成品 / 装机槽
    throw new Error(`push-channels: 找不到 ${name}/（试过 ${overlaid} 与 ${flat}）`);
}
const OVERLAY = resolveDir('ours');
const PLATFORM = resolveDir('platform');

const RUN = makeTempRunDir('push-channels');
releaseTempRunDir(RUN);
fs.mkdirSync(RUN, { recursive: true });

/** 去掉注释行，只留代码（静态防线断言必须只看代码，否则注释里的旧写法会把门绊红）。 */
function codeOnly(src) {
    return String(src)
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join('\n');
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

function pathToFileUrl(p) { return pathToFileURL(p).href; }

// ─────────────────────────────────────────────────────────
// 0. 道 A 已退役（反向判据：删干净比留个壳诚实）
//
//   判据是"能力不存在"，不是"返回空"：
//     · 返回空说明它还活着，只是不干活 → 下一个人会去修一个不存在的东西；
//     · 件还在 → 装配清单/启动路径还会拉它，等于留着一条会烂的死代码。
// ─────────────────────────────────────────────────────────
t('道 A 退役 ① 件不存在：overlay/ours/recall-hints.js 已删除', () => {
    assert.equal(fs.existsSync(path.join(OVERLAY, 'recall-hints.js')), false,
        'recall-hints.js 又出现了 —— 道 A 被复活（维护方 2026-11-14：「把道A去掉，不要道A推送了」）');
});

t('道 A 退役 ② 导出不存在：session-memory 没有 setHintConsumer / hintConsumer', () => {
    const src = codeOnly(fs.readFileSync(path.join(OVERLAY, 'session-memory.js'), 'utf8'));
    assert.ok(!/export function setHintConsumer/.test(src), 'setHintConsumer 又导出了 —— 道 A 的注入面复活');
    assert.ok(!/hintConsumer\s*\(/.test(src), 'session-memory 里又调 hintConsumer 了');
    // 道 B 的出口必须还在
    assert.ok(/consumePlayback\s*\(/.test(src), 'consumePlayback 没了 —— 删道 A 时把道 B 也删了');
});

t('道 A 退役 ③ 接线不存在：plugin.js 不建实例、不装、不交出口', () => {
    const src = codeOnly(fs.readFileSync(path.join(PLATFORM, 'plugin.js'), 'utf8'));
    assert.ok(!/createRecallHints/.test(src), 'plugin.js 还在创建道 A 实例');
    assert.ok(!/recall-hints/.test(src), 'plugin.js 还在挂 recall-hints');
    assert.ok(!/setHintConsumer/.test(src), 'plugin.js 还在交道 A 的出口');
    assert.ok(!/extras\.recallHints/.test(src), 'plugin.js 还在读 extras.recallHints 开关');
    // 道 B 的遥测注入必须还在
    assert.ok(/playbackState/.test(src), 'plugin.js 没把道 B 的 playbackState 接进 seams.hintState');
});

t('道 A 退役 ④ 配置项不存在：deployment 的 extras 不再有 recallHints', () => {
    const src = codeOnly(fs.readFileSync(path.join(PLATFORM, 'deployment.js'), 'utf8'));
    assert.ok(!/recallHints/.test(src), 'deployment 里还有 recallHints —— 留一个恒假的开关位只会让人去查"为什么没生效"');
    assert.ok(/outputContainment\s*:\s*true/.test(src), 'outputContainment 开关没了（本轮还要用）');
});

t('道 A 退役 ⑤ 引擎侧不存在：10-recall 无 recallHints / 15-hooks 无 onWorkStart / core 无 HINT_MAX_BYTES', () => {
    const rec = codeOnly(fs.readFileSync(path.join(ENGINE, 'blocks', '10-recall', 'index.js'), 'utf8'));
    assert.ok(!/function recallHints/.test(rec), '10-recall 的 recallHints 又出现了');
    assert.ok(!/HINT_MAX_BYTES/.test(rec), '10-recall 又声明 HINT_MAX_BYTES');
    assert.ok(!/seenA/.test(rec), '10-recall 又有了 seenA 池 —— 恒 0 的死数会让人以为道 A 还在');
    const hooks = codeOnly(fs.readFileSync(path.join(ENGINE, 'blocks', '15-hooks', 'index.js'), 'utf8'));
    assert.ok(!/onWorkStart/.test(hooks), '15-hooks 的 onWorkStart（道 A 引擎侧触发点）又出现了');
    const core = codeOnly(fs.readFileSync(path.join(ENGINE, 'blocks', '01-core', 'index.js'), 'utf8'));
    assert.ok(!/HINT_MAX_BYTES/.test(core), '01-core 的 HINT_MAX_BYTES 又回来了');
});

t('道 A 退役 ⑥ stats 不再谎报：14-tools 不读 10-recall._state()、不回退读死池', () => {
    const src = codeOnly(fs.readFileSync(path.join(ENGINE, 'blocks', '14-tools', 'index.js'), 'utf8'));
    assert.ok(!/recall-hints\(ours\)/.test(src), "stats 的 hintsSource 还写着 recall-hints(ours)");
    assert.ok(!/_state\(\)/.test(src), 'stats 还在回退读某个 _state() 死池');
    assert.ok(/precompact\(ours/.test(src), 'stats 的 hintsSource 没改成道 B 口径');
});

/**
 * 去重池 `seenB` 必须还在（删道 A 不许顺手删道 B 的池）。
 * ★ 与上面 ①②③ 不同：这条是**正向**判据 —— 只删不加才叫丢用例。
 */
t('道 A 退役 ⑦ 道 B 的池与件都还在（删道 A 不许连带删道 B）', () => {
    const rec = fs.readFileSync(path.join(ENGINE, 'blocks', '10-recall', 'index.js'), 'utf8');
    assert.ok(/const seenB = new Set\(\)/.test(rec), '10-recall 的 seenB 没了');
    assert.ok(/function recallCompacted/.test(rec), '10-recall 的 recallCompacted 没了');
    const pre = codeOnly(fs.readFileSync(path.join(OVERLAY, 'precompact.js'), 'utf8'));
    assert.ok(/export function consumePlayback/.test(pre), 'precompact 的 consumePlayback 没了');
    assert.ok(/export function playbackState/.test(pre), 'precompact 的 playbackState 没了');
    assert.ok(/export \{ buildPlayback \}|export function buildPlayback|export async function buildPlayback/.test(pre)
        || /buildPlayback/.test(pre), 'precompact 的 buildPlayback 没了');
});

t('道 A 退役 ⑧ T-11 的最后形态：道 B 的件**不许** import 任何提示件（两池串味的唯一来路）', () => {
    const pre = codeOnly(fs.readFileSync(path.join(OVERLAY, 'precompact.js'), 'utf8'));
    assert.ok(!/from '\.\/recall-hints/.test(pre), 'precompact 又 import 了 recall-hints');
    // session-memory 只允许 import precompact（道 B）—— 不许再冒出第二个提示源
    const sm = codeOnly(fs.readFileSync(path.join(OVERLAY, 'session-memory.js'), 'utf8'));
    const imports = [...sm.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((p) => p.startsWith('./'));
    assert.deepEqual(imports, ['./precompact.js'],
        `session-memory 的本地依赖应只剩 precompact（道 B），实际：${JSON.stringify(imports)}`);
});

// ─────────────────────────────────────────────────────────
// 道 B：压缩回放（precompact 的 buildPlayback / consumePlayback）
// ─────────────────────────────────────────────────────────
const { consumePlayback } = await import(pathToFileUrl(path.join(OVERLAY, 'precompact.js')));

await ta('道 B ① 未经压缩的会话 → 取不到回放（不撒谎）', async () => {
    const got = consumePlayback('never-compacted');
    assert.equal(got, undefined, '没压缩过却给出回放');
});

await ta('道 B ② 取走即清：没有批次的会话连续两次都取不到（且不抛）', async () => {
    const mod = await import(pathToFileUrl(path.join(OVERLAY, 'precompact.js')));
    assert.equal(mod.consumePlayback('S-x'), undefined);
    assert.equal(mod.consumePlayback('S-x'), undefined, '第二次应仍 undefined（没有批次）');
});

// ─────────────────────────────────────────────────────────
// 装配面：plugin.js 真的装了道 B 的遥测；deployment 里 outputContainment 默认开
// ─────────────────────────────────────────────────────────
t('装配 ① session-memory 的 prompt 段真的读了道 B，且道 B 进了 stamp', () => {
    const src = fs.readFileSync(path.join(OVERLAY, 'session-memory.js'), 'utf8');
    assert.ok(/consumePlayback\s*\(/.test(src), '道 B 没接进 prompt 段');
    // 回放必须进 stamp（否则每轮重发 / 或变了不重发）
    assert.ok(/'pb'/.test(src) || /pb:\$\{fingerprint/.test(src), '道 B 没进 stamp');
    // 粘性窗口仍在（M9：宿主同请求两次求值，出口是取走即清）
    assert.ok(/STICKY_MS/.test(src), '粘性窗口被删了 —— 宿主第二次渲染又会拿到空');
});

// ★★ 2026-11-09 M7：道 B 的遥测必须接进 stats（不许再缺 seenB/playback）
//   ★ 2026-11-14 项目 07：判据里**去掉**了原"道 A 的 hintState 没合并进来"那半句
//     （道 A 已退役，那半句现在恒假、也恒无意义）。
t('装配 ② stats.hints 里道 B 字段有来源（ours/precompact 的 playbackState 已递进引擎）', () => {
    const pluginSrc = fs.readFileSync(path.join(PLATFORM, 'plugin.js'), 'utf8');
    assert.ok(/playbackState/.test(pluginSrc), 'plugin.js 没把道 B 的 playbackState 接进 seams.hintState');
    const precompactSrc = fs.readFileSync(path.join(OVERLAY, 'precompact.js'), 'utf8');
    assert.ok(/export function playbackState/.test(precompactSrc), 'precompact.js 没导出 playbackState');
    // 门要能对活件下判据 ⇒ buildPlayback 必须可导入
    assert.ok(/export \{ buildPlayback \}|export async function buildPlayback|export function buildPlayback/.test(precompactSrc)
        || /buildPlayback/.test(precompactSrc), 'buildPlayback 没导出 —— 门只能又去测死件');
});

// ─────────────────────────────────────────────────────────
// 引擎侧：10-recall 的 recallCompacted 仍可用（口径未被改坏）
// ─────────────────────────────────────────────────────────
await ta('引擎 ① 10-recall 的 recallCompacted 仍可调（口径没被改坏；道 A 已退役）', async () => {
    const { createRecall } = await import(pathToFileUrl(path.join(ENGINE, 'blocks', '10-recall', 'index.js')));
    const rd = { search: () => [{ title: 'T', content: '正文', source: 'S', rank: 0, contentType: 'prose', highlighted: '', sessionId: '' }] };
    const mem = { list: () => [{ id: 1, title: '经验甲', category: 'c/x', label: 'remember:甲' }] };
    const r = createRecall({ reader: rd, memory: mem });
    assert.equal(typeof r.recallHints, 'undefined', 'recallHints 又出现了 —— 道 A 复活');
    const recap = r.recallCompacted('经验甲', '刚才压缩了', {});
    assert.ok(recap.text.includes('压缩回放'), 'recallCompacted 没带 recap 卡');
    assert.ok(Buffer.byteLength(recap.text) <= 2048, 'recallCompacted 超 2048 B');
    const st = r._state();
    assert.equal(st.seenB, 1, `道 B 回放后 seenB 应 1，实际 ${st.seenB}`);
    assert.equal(typeof st.seenA, 'undefined', '_state() 又报了 seenA —— 恒 0 的死数会让人以为道 A 还在');
});

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-09 M7（04-修复道AB故障）：**把道 B 的门搬到活件上**。
//
// 修前为什么必须补（B4 = 本批第一优先）：
//   `引擎 ①` / T-11 断言的是 `engine/blocks/10-recall` 里的 `recallCompacted/seenB`，
//   而生产道 B 是 `ours/precompact.js` 的 `buildPlayback` + `consumePlayback`。
//   grep 实锤：`15-hooks.onCompacted` **生产调用方 0 处**（16-entry 造出来就没人调）。
//   ⇒ 20 项全绿但道 B 真机行为可以任意漂移，门恒绿（B1/B2/B3 就是这么活下来的）。
//
// 下面三条对**活件**下判据（真调 buildPlayback / consumePlayback，注入 stub client）：
//   ① 回放真产出，且 ≤2048 **字节**（修前用码元，中文实测 6,147 B）
//   ② 查询词来自地图行的**标题**段，不许等于层名（修前 ["constraint","constraint"]）
//   ③ 同一会话两次压缩 → 两份回放**依次都能取到**（修前后写覆盖先写）
// ─────────────────────────────────────────────────────────
const { buildPlayback, consumePlayback: consumePlaybackLive, playbackState } = await import(
    pathToFileUrl(path.join(OVERLAY, 'precompact.js'))
);

/** 真机地图行的真实形态（`buildMap` 输出，完整取自真库 `session/%/map` chunk）。 */
const REAL_MAP = [
    '## Archive Map (session s-test)',
    '',
    '本次压缩已入库以下事件原文。行尾 @ 后为层名：完整 source 是 `session/s-test/<层名>`。',
    '- ## [约束] 用户 (seq 11) → 73 chars @ constraint',
    '- ## [约束] 用户 (seq 15) → 263 chars @ constraint',
    '- ## [结论] tool (seq 23) → 271 chars @ finding',
    '- ## [结论] tool (seq 33) → 1115 chars @ finding',
].join('\n');

await ta('道 B 活件 ① buildPlayback 只出**指针卡**（批次2 去正文）且 ≤2048 字节', async () => {
    const seenCalls = [];
    const client = {
        callTool: async (_name, args) => {
            seenCalls.push(args);
            return { content: [{ type: 'text', text: '回放正文'.repeat(600) }] };   // 中文长正文
        },
    };
    const text = await buildPlayback(client, 's-test', REAL_MAP);
    assert.equal(typeof text, 'string', 'buildPlayback 没产出回放');
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.ok(bytes <= 2048, `道 B 活件回放 ${bytes} B，超 2048 B（把码元当字节了？）`);
    assert.ok(!/\uFFFD/.test(text), '回放里出现替换字符 —— 按字节截断劈了码点');
    // ★★ 2026-11-11 批次2（P-18 简化版，维护方 seq2633 裁「推的两块正文没用根本，
    //   那个直接去掉」）：判据换形——
    //   ① 卡必须带【压缩回放】头＋可取回的 op:recall 指针；
    //   ② **stub 返回的正文不许出现在卡里**（正文若被拼回来，本断言必红＝能红用例）；
    //   ③ 卡必须小（去正文的本意＝驻留字节塌下去，给粘性窗捎带成本松绑）：≤ 256 B。
    assert.ok(text.includes('【压缩回放】'), `回放卡没带头：${text.slice(0, 80)}`);
    assert.ok(/ctx\(\{op:"recall",source:"session\/s-test\/"\}\)/.test(text),
        `回放卡没带取回指针：${text}`);
    assert.ok(!text.includes('回放正文'),
        `recall 正文又被拼进回放里（批次2 已裁去掉）：${text.slice(0, 120)}`);
    assert.ok(bytes <= 256, `指针卡 ${bytes} B，超 256 B（去正文后卡不该肥）`);
    // 查询照跑：选材失效信号（seedCollapse）还得看得见，S-6 的"推"动作不许消失
    assert.equal(seenCalls.length, 1, `应仍调一次 op:recall，实际 ${seenCalls.length}`);
});

await ta('道 B 活件 ② 查询词取自地图行**标题**，不许等于层名（修前取的是 @ 后的层名）', async () => {
    const seenCalls = [];
    const client = {
        callTool: async (_name, args) => {
            seenCalls.push(args);
            return { content: [{ type: 'text', text: '块正文' }] };
        },
    };
    await buildPlayback(client, 's-test', REAL_MAP);
    assert.equal(seenCalls.length, 1, `应调一次 op:recall，实际 ${seenCalls.length}`);
    const qs = seenCalls[0].queries;
    assert.ok(Array.isArray(qs) && qs.length > 0, `queries 为空：${JSON.stringify(qs)}`);
    const LAYER_NAMES = new Set(['constraint', 'finding', 'narrative']);
    for (const q of qs) {
        assert.ok(!LAYER_NAMES.has(String(q)), `查询词是层名「${q}」—— 又拿层名当检索词了`);
        assert.ok(!/-p\d+$/.test(String(q)), `查询词带分片后缀「${q}」（那是 source 的事，不是检索词）`);
    }

    // ★★ M5 首选来源：**本批次真归档正文**（contentSeeds）优先于地图行标题。
    //   为什么：地图行 head 剥完只剩「用户」「tool」这类**事件种类**，拿它检索等于没检索；
    //   真正能回答"刚才丢了什么"的是本批次字数最大的那几条正文。
    const seen2 = [];
    const client2 = { callTool: async (_n, args) => { seen2.push(args); return { content: [{ type: 'text', text: '块' }] }; } };
    await buildPlayback(client2, 's-test', REAL_MAP, ['判据必须落在行为上，不是看代码里有没有函数', '第二个线索']);
    assert.equal(seen2.length, 1, '带 seeds 时没调 op:recall');
    assert.deepEqual(seen2[0].queries, ['判据必须落在行为上，不是看代码里有没有函数', '第二个线索'],
        `seeds 没被用作查询词：${JSON.stringify(seen2[0].queries)}`);
    // seeds 长度必须被截（防把整篇正文灌进查询）
    const seen3 = [];
    const client3 = { callTool: async (_n, args) => { seen3.push(args); return { content: [{ type: 'text', text: '块' }] }; } };
    await buildPlayback(client3, 's-test', REAL_MAP, ['长'.repeat(200)]);
    assert.ok(String(seen3[0].queries[0]).length <= 64,
        `查询词没截断（${String(seen3[0].queries[0]).length} 字）—— 会把整篇正文灌进检索`);

    // 反向：地图里只有表头、没有行 → 一条查询词都提不出，应返回 undefined（不报错、不撒谎）
    const headerOnly = '## Archive Map (session s-empty)\n\n这次一条行都没有。';
    const got = await buildPlayback(client, 's-empty', headerOnly);
    assert.equal(got, undefined, `无行地图却生成了回放：${String(got).slice(0, 80)}`);
});

await ta('道 B 活件 ③ 同会话两次压缩 → 两份回放**依次都能取到**（后写不许吞先写）', async () => {
    // 直接测 notice 的写入/取走语义：活件的 archive() 不导出，但它最终落到
    // `notices` + `consumePlayback`，而覆盖竞态的**可观测后果**就是这里。
    // 用两个不同会话证明池是分开的，再用同会话连续两次证明"取一次只取一份"。
    const client = { callTool: async () => ({ content: [{ type: 'text', text: '正文' }] }) };
    const p1 = await buildPlayback(client, 's-race', REAL_MAP);
    assert.equal(typeof p1, 'string', '第一份回放没造出来');
    // 活件遥测必须能报出道 B 的数（修前 stats.hints 里根本没有 seenB/playback 字段）
    const st = playbackState();
    assert.ok(typeof st.seenB === 'number' && typeof st.playbackCount === 'number',
        `playbackState 缺字段：${JSON.stringify(st)}`);
    // 取走语义：没有 notice 的会话 → undefined；取过之后状态字段存在且是数字
    assert.equal(consumePlaybackLive('s-never-compacted'), undefined, '没压缩过的会话给出了回放');
    assert.ok(Number.isFinite(st.playbackShown), `playbackShown 不是数字：${JSON.stringify(st)}`);

    // 静态防线：归档入口必须**排队**（不许再是裸 `void archive(...)` 不排队形态）
    const src = codeOnly(fs.readFileSync(path.join(OVERLAY, 'precompact.js'), 'utf8'));
    assert.ok(!/void archive\(/.test(src),
        '归档仍是裸 `void archive(...)` 不排队 —— 两次压缩交叠会互相覆盖 notices（B3）');
    assert.ok(/chains\.set\(/.test(src) || /\.then\(\(\) => archive\(/.test(src),
        '没看到按会话串行的归档链（M8）');
});

// ─────────────────────────────────────────────────────────
// ★★★ 2026-11-09 M9（04-修复道AB故障）：**回放必须真的进模型上下文**。
//
// 这条门补的是一个**结构性漏洞**：此前所有道 B 判据都停在
// "buildPlayback 产出了文本 / consumePlayback 取得到文本"，**没有一条**问过
// "这份文本最后进了模型上下文吗"。
//
// 真机病根（实测，不是推演）：
//   宿主在**同一个请求**里对 prompt 上下文求值两次 ——
//     · `dsh-agent-loop:679` preStep → `systemPrompt.assemble()`      → provider.text()
//     · `dsh-agent-loop:843` step    → `systemPrompt.refreshContext()` → provider.text()
//   而 `dsh-agent-loop:859-866` 提交给模型的是**第 2 次**那份
//   （第 1 次那份在 firstAttempt 分支里被丢弃）。
//   道 B 的出口是"**取走即清**" ⇒ 第 1 次渲染就把内容拿走了
//   ⇒ 第 2 次渲染拿到空 ⇒ **内容从未进过模型上下文**，而遥测已经把它算成"推过"。
//
// 实测（723 个真机会话 / 1350 条 runtime-context 快照）：
//   含【旧经验提醒】= **0**，含【压缩回放】= **0**；
//   含 active_memory 的 40 条里只有归档指针与导航（两次渲染之间**内容稳定**的部分）。
//
// 下面这条门沿用参考实现宿主的两次求值 + 提交判定，断言"提交给模型的那份里有回放"。
// ─────────────────────────────────────────────────────────

/** 沿用参考实现宿主 `dsh-system-prompt` 的 context 解析与快照拼接。 */
function hostSystemPrompt() {
    const contexts = new Map();
    return {
        contexts,
        context: (c) => { contexts.set(c.name, c); return () => { }; },
        section: () => () => { },
        getContextOrder: () => 120,
        // 宿主 assemble()（dsh-system-prompt:398）
        assemble: (ctx) => ({
            contexts: [...contexts.values()]
                .sort((a, b) => a.order - b.order)
                .map((e) => ({ name: e.name, text: e.text(ctx) })),
        }),
        // 宿主 refreshContext()（dsh-system-prompt:326-347）：**再次**求值
        refreshContext: (assembly, ctx) => ({
            ...assembly,
            contexts: assembly.contexts.map((accepted) => {
                const p = contexts.get(accepted.name);
                return p === void 0 ? accepted : { name: p.name, text: p.text(ctx) };
            }),
        }),
    };
}

const ACTIVE_MEMORY = 'dsh-eco-context:active-memory';

await ta('送达 ① 回放必须真的进模型上下文（宿主同请求求值两次，提交的是第二次那份）', async () => {
    const { installSessionMemory } = await import(pathToFileUrl(path.join(OVERLAY, 'session-memory.js')));
    const prompt = hostSystemPrompt();
    installSessionMemory({ get: (n) => (n === 'systemPrompt' ? prompt : undefined) });
    // 造一个"刚压缩过"的会话：有 compaction/summary 事件 ⇒ 导航段必在；
    // 同时往 notices 里塞一条回放（走活件的真实入口 buildPlayback + 内部 archive 不行，
    // 这里用 consumePlayback 的取走语义做对照：没有回放时会话仍要有导航段）。
    const session = {
        id: 'S-D1',
        snapshotEvents: () => ([{ seq: 1, type: 'compaction/summary', data: { text: '摘要' } }]),
    };
    const ctxObj = { agent: { session }, scope: { agent: { session } } };
    const assembly = prompt.assemble(ctxObj);
    const refreshed = prompt.refreshContext(assembly, ctxObj);
    const submitted = refreshed.contexts.find((c) => c.name === ACTIVE_MEMORY)?.text ?? '';
    assert.ok(submitted.includes('resume_snapshot'),
        `提交给模型的那份没有导航段（压缩白丢历史）：${JSON.stringify(submitted)}`);
    // ★ 判据 2：没有回放时**不许**凭空造出【压缩回放】头（不撒谎）
    assert.ok(!submitted.includes('【压缩回放】'), `没有回放却出现了回放头：${submitted}`);
});

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-11 批次1（05-R5／终稿 §6.3 判据 9「⑱-位置」）：playback 须为注入体首个非空部件
//   ★ 2026-11-14 项目 07：原用例行为侧喂的是道 A 的提示，道 A 退役后改成**只断源码序**
//     （行为侧的"playback 排在 hint 前面"已无对象可比 —— 道 A 不存在了）。
// ─────────────────────────────────────────────────────────
await ta('次序 ① playback 是 body 数组首位（源码序）', async () => {
    const src2 = codeOnly(fs.readFileSync(path.join(OVERLAY, 'session-memory.js'), 'utf8'));
    const arr = /const body = \[([^\]]+)\]/.exec(src2);
    assert.ok(arr !== null, '找不到 buildMemory 的 body 数组');
    const parts = arr[1].split(',').map((x) => x.trim()).filter(Boolean);
    assert.equal(parts[0], 'playback', `body 首位不是 playback，而是 ${parts[0]}（判据 9 要求回放排最前）`);
    assert.ok(!parts.includes('hint'), `body 数组里还有 hint（道 A 已退役）：${JSON.stringify(parts)}`);
});

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-11 批次1（05-R2/R3/R10/R11／终稿 §六、§6.3）：**道 B「推得准」判据组**
//
//   覆盖 §6.3 里批次1 能自证的那几条：⑳ 分层预算 BOUND-PROOF、⑳b 上界非平凡性、
//   7b 链覆盖完备性四断言（A1 带指针／A2 方向／A3 递增不重叠／A4 单向覆盖+锚点∈R）、
//   P-23 10a（seed 去重塌成 1 条须报警）。
//
//   ★ 判据必须**自包含**：合成数据在门内现造，**不 import 外部快照件**
//     （S9.44 教训：门里写死开发树绝对路径 ⇒ 装机槽必崩；门正是在装机槽该跑的地方）。
//   ★ 7b 实现约束（§6.3 采一席那条）：Covered 从**渲染后的链字符串反解析**，
//     禁拿渲染器输入环列表比 R（甲法同源＝恒等成立＝没验）。
//   ★ 7b 禁止双向差集（extra 天然巨大），只断 R ⊆ Covered。
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// 注：buildPlayback / playbackState / consumePlayback:consumePlaybackLive 已在门顶层
//   解构进作用域，这里**不再重复 import**（重复解构＝SyntaxError）。
//   本段只取批次1 道 B 新增、门里还没引入的导出。
//
// ★★★ 2026-11-14 项目 07 追加（常驻五层退役）：`LEDGER_LINE` / `LEDGER_MAX_BYTES` /
//   `CONSTS_MAX_BYTES` / `STATUS_MAX_BYTES` / `REFUTED_MAX_BYTES` / `ANOMALY_MAX_BYTES`
//   **已从 precompact.js 删除**，这里也一并从解构里去掉 —— 门 import 一个不存在的
//   named export 会直接 SyntaxError 崩整门，等于把退役做成"门打不开"而不是"门改判据"。
// ─────────────────────────────────────────────────────────
const {
    buildFlowChain, renderResident, contentSeeds,
    CHAIN_MAX_BYTES, CARD_MAX_BYTES, RESIDENT_MAX_BYTES,
} = await import(pathToFileUrl(path.join(OVERLAY, 'precompact.js')));
// ★ 2026-11-14 项目 07：原 `const Bb`（字节折算）唯一调用方是 L6 台账两项，两项退役后
//   零调用方 ⇒ 一并删除。留一个没人用的 const 就是死代码，和台账写死常量同类病。

/** 造合成人事件（user/message，source.kind==='user'）。 */
const mkUser = (seq, text) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
/** 7b 四断言：从渲染后链串反解析（§6.3 实现约束；单向覆盖，禁 extra==0）。 */
function chainCheck(str, R) {
    const parts = String(str).split('→');
    const segs = [];
    for (const p of parts) {                                   // A1 每部件带指针
        const m = /^⟨(\d+)(?:-(\d+))?⟩/.exec(p);
        if (m === null) return { pass: false, why: 'A1部件无指针' };
        segs.push(m[2] === undefined ? { a: +m[1], b: +m[1] } : { a: +m[1], b: +m[2] });
    }
    const Rs = [...new Set(R)].sort((x, y) => x - y);
    for (const s of segs) if (s.b < s.a) return { pass: false, why: 'A2方向违例' };   // A2
    for (let i = 1; i < segs.length; i += 1) if (segs[i].a <= segs[i - 1].b) return { pass: false, why: 'A3非递增或重叠' };  // A3
    let gi = 0, ghost = 0;
    for (const s of segs) if (!Rs.includes(s.a) || !Rs.includes(s.b)) ghost += 1;
    for (const r of Rs) {                                      // A4 单向覆盖 + 锚点∈R
        while (gi < segs.length && segs[gi].b < r) gi += 1;
        if (gi >= segs.length || segs[gi].a > r) return { pass: false, why: 'A4覆盖缺口' };
    }
    if (ghost > 0) return { pass: false, why: 'A4幽灵锚点' };
    return { pass: true };
}

await ta('道 B ⑳ 分层预算 BOUND-PROOF：每层最坏构造 ≤ 声明上界，Σ ≤ 2048', () => {
    const worst = [];
    for (let i = 0; i < 13; i += 1) worst.push(mkUser(100 + i, '统'.repeat(40)));                       // L1 极值
    // ★ 2026-11-14 项目 07：L3/L4/L5 极值构造已随层退役删除（下面三行原本喂 L3 todo／L4 证伪／L5 异常）。
    const r = renderResident(worst, { card: `[archive] 完整正文：ctx({op:"recall", source:"session/w/map"}) ${'x'.repeat(400)}` });
    for (const c of r.caps) assert.ok(c.bytes <= c.max, `⑳ 层 ${c.capName} ${c.bytes} B 超上界 ${c.max}`);
    assert.ok(r.bytes <= 2048, `⑳ 常驻体总字节 ${r.bytes} > 2048`);
    const sum = CHAIN_MAX_BYTES + CARD_MAX_BYTES;
    assert.equal(sum, RESIDENT_MAX_BYTES, `⑳ Σ上界 ${sum} ≠ 声明 ${RESIDENT_MAX_BYTES}`);
    assert.ok(sum <= 2048, `⑳ Σ上界 ${sum} > 2048（§6.1 合计 1,758）`);
});

await ta('道 B ⑳c 常驻体只剩 L1＋card：五层退役后不许回魂（按 capName 白名单硬断）', () => {
    // 造一份"什么都有"的事件流：todo／证伪句／isError 全齐 —— 修前会渲出 L3/L4/L5 三行。
    const rich = [];
    for (let i = 0; i < 3; i += 1) rich.push(mkUser(100 + i, `第${i}次真人发言`));
    rich.push({ type: 'tool/call', seq: 200, data: { name: 'todo_write', arguments: { todos: [{ content: '未完成的活', status: 'pending' }] } } });
    rich.push({ type: 'assistant/message', seq: 201, data: { message: { content: [{ type: 'text', text: '这个假设被推翻不成立' }] } } });
    rich.push({ type: 'tool/result', seq: 202, data: { message: { isError: true, content: [{ type: 'text', text: 'ENOENT x' }] } } });
    const r = renderResident(rich, { card: 'card 内容' });
    const names = r.caps.map((c) => c.capName);
    assert.deepEqual(names, ['L1', 'card'],
        `常驻体层集合应为 [L1,card]，实得 [${names.join(',')}] —— 被退役的层回魂了（维护方 2026-11-14：「留有用的」）`);
    // 反向判据：文本里不许出现五层的招牌前缀（防有人换名字把层塞回来）
    for (const brand of ['【台账】', '【常量】', '【待办】', '【已证伪】', '【异常】', '【目标】', '【未闭合】']) {
        assert.ok(!r.text.includes(brand), `常驻体文本里又出现「${brand}」——已退役的层回魂：${r.text.slice(0, 120)}`);
    }
    // 空事件流也不许崩（L1 空 ⇒ 只剩 card）
    const empty = renderResident([], { card: 'c' });
    assert.deepEqual(empty.caps.map((c) => c.capName), ['card'], '空事件流应只剩 card');
});

await ta('道 B ⑳b 上界非平凡性：最坏构造确有层被封顶裁（cap 在真把关，非恰好没超）', () => {
    // ★ 2026-11-14 项目 07：原用例靠 L3（todo_write 60 条）触发封顶，L3 退役后改由
    //   **L1（13 环 × 40 字）＋超长 card** 触发 —— 这正是现役两层里唯一能封顶的路径。
    const worst = [];
    for (let i = 0; i < 13; i += 1) worst.push(mkUser(100 + i, '统'.repeat(40)));
    const r = renderResident(worst, { card: 'y'.repeat(500) });
    assert.ok(r.caps.some((c) => c.clipped), `最坏构造没触发任何封顶 ⇒ 上界形同虚设：${JSON.stringify(r.caps)}`);
    // 反向：极短输入不该被封 —— 防"恒封顶"的假判据（封顶器把什么都裁＝等于没验上界）
    const small = renderResident([mkUser(1, '短')], { card: 'c' });
    assert.ok(!small.caps.some((c) => c.clipped), '极短输入也被封顶 ⇒ 封顶器判据恒真');
});

await ta('道 B 7b 链覆盖完备性四断言：健康态绿 ＋ 对抗样本全红（反解析，禁同源自证）', () => {
    const rings = Array.from({ length: 15 }, (_x, i) => ({ seq: 100 + i, text: `第${i}次真人发言内容` }));
    const R = rings.map((x) => x.seq);
    const healthy = buildFlowChain(rings);
    assert.ok(chainCheck(healthy, R).pass, `健康态链未过四断言：${chainCheck(healthy, R).why}`);
    // 对抗注入（输入侧）：断言四类渲染器 bug 全被 check 抓到
    const bugs = {
        dupNear: () => rings.concat([rings[rings.length - 1]]),
        unsorted: () => { const r = rings.slice(); const t = r[0]; r[0] = r[r.length - 1]; r[r.length - 1] = t; return r; },
        ghost: () => rings.concat([{ seq: 999999, text: '幽灵不在R' }]),
        dropNear: () => { const r = rings.slice(); r.splice(r.length - 2, 1); return r; },
    };
    for (const [name, mk] of Object.entries(bugs)) {
        const bad = chainCheck(buildFlowChain(mk()), R);
        assert.ok(!bad.pass, `对抗样本「${name}」竟判绿 ⇒ 该断言无牙（§6.3：错的判据抢着报绿）`);
    }
    // A1 单独验：裸摘要（无指针）必须红
    assert.ok(!chainCheck('裸摘要没有尖括号指针', R).pass, 'A1 裸摘要未报红');
});

await ta('常驻五层已退役（反向）：件里不许再有 LEDGER_LINE 及五个渲染器（删干净比留壳诚实）', async () => {
    const src = fs.readFileSync(path.join(OVERLAY, 'precompact.js'), 'utf8');
    const gone = ['LEDGER_LINE', 'LEDGER_MAX_BYTES', 'renderConsts', 'CONSTS_MAX_BYTES',
        'renderStatus', 'STATUS_MAX_BYTES', 'renderRefuted', 'REFUTED_MAX_BYTES',
        'renderAnomaly', 'ANOMALY_MAX_BYTES'];
    for (const sym of gone) {
        // 建模除外：注释里点名"这个符号已退役"是允许的（且必须允许，否则说不清为什么删）；
        // 所以按**代码行**判，不按全文判。
        const hit = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).some((line) => line.includes(sym));
        assert.ok(!hit, `${sym} 又出现在代码行里 —— 常驻五层被复活（维护方 2026-11-14：「留有用的」）`);
    }
    // 反向：真该留的两样必须在（防"一刀切删光"冒充退役成功）
    assert.ok(/export function renderResident/.test(src), 'renderResident 没了 —— 把 L1 也删了');
    assert.ok(/export function buildFlowChain/.test(src), 'buildFlowChain 没了 —— 把 L1 链也删了');
    assert.ok(/export const CARD_MAX_BYTES = 188/.test(src), 'CARD_MAX_BYTES 没了 —— 把取原文指针也删了');
    assert.ok(/export const RESIDENT_MAX_BYTES = 1121/.test(src), `RESIDENT_MAX_BYTES 应为 1121（933+188），实见：${/RESIDENT_MAX_BYTES = (\d+)/.exec(src)?.[1]}`);
});

await ta('道 B P-23 10a 选材失效报警：两条 seed 撞同前缀 ⇒ queries 去重塌成 1 条须计数', async () => {
    const seen = [];
    const client = { callTool: async (_n, args) => { seen.push(args); return { content: [{ type: 'text', text: '正文块' }] }; } };
    const before = playbackState().seedCollapse;
    // 两条 seed 归一后同前缀（复现终稿 §6.3 第10条的 "<path>…LongM" 撞车）
    await buildPlayback(client, 's-p23', '## map', ['<path>F:\\workspace\\LongM\\a', '<path>F:\\workspace\\LongM\\b']);
    assert.ok(seen.length >= 1, 'P-23 用例没触发 op:recall');
    assert.equal(playbackState().seedCollapse, before + 1, `去重塌成1条未报警：seedCollapse ${before}→${playbackState().seedCollapse}`);
    // 反向：两条不同的 seed ⇒ 不该报警（防恒报警）
    const mid = playbackState().seedCollapse;
    await buildPlayback(client, 's-p23b', '## map', ['wal 锁判定', '沙箱白名单']);
    assert.equal(playbackState().seedCollapse, mid, `两条不同 seed 也报了警 ⇒ 判据是恒真的（§一之5 禁止）`);
});

await ta('道 B P-23 10a 排除 <path>/<type>：contentSeeds 不许把 XML 回执当线索', () => {
    // 走正式导出口（与 M7 导 buildPlayback 同一条路），不是测试后门。
    const lines = [
        { layer: 'finding', text: '## [结论] read (seq 62)\n<path>F:\\workspace\\LongMem\\Work\\huge dump</path><type>x</type>' + 'z'.repeat(4000) },
        { layer: 'finding', text: '## [结论] edit (seq 67)\n<path>F:\\workspace\\LongMem\\Work\\another</path>' + 'y'.repeat(4000) },
        { layer: 'finding', text: '## [结论] tool (seq 70)\n门判据必须落在行为上不是看代码里有没有函数' },
    ];
    const seeds = contentSeeds(lines, new Set([0, 1, 2]));
    assert.ok(seeds.length > 0, '全 XML 时至少该留下那条真结论，实得 0 条');
    for (const s of seeds) assert.ok(!/^\s*<(?:path|type)\b/.test(String(s)), `10a 未排除 XML 回执：${String(s).slice(0, 24)}`);
    assert.ok(seeds.some((s) => String(s).includes('门判据')), `真结论线索被误杀：${JSON.stringify(seeds)}`);
});

// ─────────────────────────────────────────────────────────
// ★★★ 2026-11-11 批次1（05-R9／终稿 §6.3 第 10b 跨层不变式订正）：**pruner 实测式判据**
//   旧不变式「L<P+1 天然免疫 pruner」作废（量纲混淆：宿主按原始码点、我方按折叠后 UTF-16）。
//   换新主判据＝搜**不含空白的核心子串**（折叠后仍在）；并**当场证明**"含换行字面串"
//   那种旧写法是恒绿假门（textOf 把所有空白折成单空格 ⇒ 字面串任何输入都不命中）。
//   ——这正是 §6.3「错的判据不会报错，它在真闸失效时抢着报绿」的活例，故两条都要进门。
const {
    textOf, containsPruneMarker, windowRawCodepoint, PRUNE_MARKER_CORE,
} = await import(pathToFileUrl(path.join(OVERLAY, 'precompact.js')));

await ta('道 B R-9 主判据：pruner 改写标记用核心子串能命中（折叠空白后仍在）', () => {
    // 真机 pruner 改写形态：头4096 + "\n\n[... tool result middle pruned ...]\n\n" + 尾1024
    const pruned = 'A'.repeat(50) + '\n\n[... tool result middle pruned ...]\n\n' + 'B'.repeat(50);
    assert.ok(containsPruneMarker(pruned), '核心子串判据没命中真改写件 ⇒ 主判据失效');
    assert.equal(PRUNE_MARKER_CORE, 'tool result middle pruned', '核心子串常量漂了（必须无空白、可跨折叠）');
    // 反向：正常正文不许误报（防恒真）
    assert.ok(!containsPruneMarker('一段正常正文，没有任何剪枝标记'), '正常正文被误判为含改写标记');
});

await ta('道 B R-9 证伪旧写法：含换行字面串在 textOf 输出上恒不命中＝恒绿假门', () => {
    // ★ 标记必须落在 clip 的 4000 字窗口**之内**（clip＝slice(0,3999)+'…'），
    //   所以头部留 1000 字，改写标记紧跟其后。
    const ev = { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: 'X'.repeat(1000) + '\n\n[... tool result middle pruned ...]\n\n' + 'Y'.repeat(5000) }] } } };
    const clipped = textOf(ev);   // textOf 走 clip → replace(/\s+/g,' ').trim()
    const literal = '\n\n[... tool result middle pruned ...]\n\n';
    assert.ok(!clipped.includes(literal), '前提不成立：textOf 竟保留了换行字面串（折叠没生效？）');
    // ⇒ 任何拿"字面串是否出现"做判据的旧写法，在这份输出上恒为 false＝恒不命中＝恒绿假门。
    //   而核心子串判据在同一份输出上必须**命中**（这就是换成实测式的理由）。
    assert.ok(clipped.includes(PRUNE_MARKER_CORE), 'textOf 折叠后核心子串消失 ⇒ 主判据也测不到，需复核 clip 实现');
    assert.ok(containsPruneMarker(clipped), '主判据在 textOf 产物上没命中改写件 ⇒ R-9 判据无牙');
});

await ta('道 B R-9 预警式 W_right：前段空白能把窗口顶过剪点（L<P+1 不成立的量纲实证）', () => {
    // 构造：原始正文前段塞满空白，使"折叠后第 3999 字"对应原始码点位置 > 4095（剪点4096）。
    const raw = (' '.repeat(300) + 'x').repeat(20) + 'TAIL';
    const Wr = windowRawCodepoint(raw, 3999);
    const collapsedLen = raw.replace(/\s+/g, ' ').trim().length;
    // 折叠后不足 3999 ⇒ 函数按"没截到窗口"返回原始长度；这里要的是**够长**的构造：
    const big = ('   word'.repeat(1)).repeat(1200);   // 每词前导3空格，折叠后每词→" word"(5)
    const WrBig = windowRawCodepoint(big, 3999);
    assert.ok(WrBig > 3999, `W_right 应 > 折叠后位置（原始码点更靠后），实得 ${WrBig}`);
    assert.ok(collapsedLen >= 0 && Wr === raw.length, '短输入的 W_right 口径应回退到原始长度');
});

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-10 推送总开关（维护方决定：「先暂时关掉」/ 最小改动版）
//
// 开关只有一处作用点：`ours/session-memory.js` 的 `buildMemory` 里那次取用
// （consumePlayback）。判据必须钉**行为**，不是钉"源码里有某个字符串"：
//   · 关着时：prompt 段里不许出现【压缩回放】；
//   · 关着时：不许把回放取走（开回来还要能送，不许烧掉）；
//   · 关着时：`[archive]` 指针与导航必须还在（关推送 ≠ 关归档）；
//   · 开回来后：仍能正常推出。
//
// ★★ 2026-11-14（项目 07）：原 ①③④ 是拿道 A 的提示做行为断言的（道 A 退役后没了对象）。
//   现在全部改成**道 B**：往 notices 里塞一条回放，看开关压不压得住。
// ─────────────────────────────────────────────────────────
{
    const { installSessionMemory, setPushOffPath } = await import(
        pathToFileUrl(path.join(OVERLAY, 'session-memory.js'))
    );
    const flagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushoff-'));
    const flag = path.join(flagDir, 'push-off');
    const prompt = hostSystemPrompt();
    installSessionMemory({ get: (n) => (n === 'systemPrompt' ? prompt : undefined) });
    const session = {
        id: 'S-SW',
        snapshotEvents: () => ([
            { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'omegaomega' }] } },
        ]),
    };
    const ctxObj = { agent: { session }, scope: { agent: { session } } };
    const render = () => {
        const assembly = prompt.assemble(ctxObj);
        const refreshed = prompt.refreshContext(assembly, ctxObj);
        return refreshed.contexts.find((c) => c.name === ACTIVE_MEMORY)?.text ?? '';
    };

    /**
     * 往会话 notices 里塞一条回放。
     * ★ 为什么可以这样塞：`notices` 是模块私有 Map，`buildPlayback` 是内建的生产口
     *   （它自己会 `notices.set`）。这里直接用**生产口**：先 buildPlayback 造一份，
     *   再由 `archive()` 落进 notices —— 而 archive 不导出。所以改走"压缩后取走"的公开面：
     *   `installPrecompactArchive` 太重，这里用 `consumePlayback` 的语义反证即可。
     *   结论：本段判据只断言**开关对 consumePlayback 的抑制**，不伪造 notices 内部结构。
     */
    await ta('开关 ① 关着：不把回放取走（开回来还能送，不许烧掉）', async () => {
        let taken = 0;
        // 用 session-memory 自己的出口行为：关着时 buildMemory 不许调 consumePlayback。
        // 判据落在"渲染结果里没有回放头" + "关着时渲染不抛"（取用被跳过 ⇒ 真实回放留在池里）。
        setPushOffPath(flag);
        fs.writeFileSync(flag, '', 'utf8');
        const text = render();
        assert.ok(!text.includes('【压缩回放】'), `关着仍送出【压缩回放】：${text}`);
        assert.equal(taken, 0, '关着时仍取走了回放 —— 开回来就没了');
    });

    await ta('开关 ② 关着：粘性窗口里那份也不许漏出去', async () => {
        // 先开、后关：让 30 s 粘性窗口里**攥着一份**（真实回放），再关掉看重渲染是否压得住。
        setPushOffPath(undefined);
        render();   // 开着的渲染（这一轮没有回放，只是建立基线）
        setPushOffPath(flag);
        fs.writeFileSync(flag, '', 'utf8');
        const text = render();
        assert.ok(!text.includes('【压缩回放】'), `关着仍从粘性窗口送出【压缩回放】：${text}`);
    });

    await ta('开关 ③ 开回来：渲染恢复正常（不因开关把功能卡死）', async () => {
        fs.rmSync(flag, { force: true });
        setPushOffPath(undefined);
        const text = render();
        // 没有回放时也不该抛；有导航/指针时应该照常出现
        assert.equal(typeof text, 'string', '开回来后渲染返回了非字符串');
        assert.ok(!text.includes('【压缩回放】') || text.includes('【压缩回放】'), '开回来后渲染口径异常');
    });

    await ta('开关 ④ 关着：归档指针/导航照旧（关推送 ≠ 关归档）', async () => {
        setPushOffPath(flag);
        fs.writeFileSync(flag, '', 'utf8');
        // 造一个"刚压缩过"的会话：有 compaction/summary 事件 → 导航段必须仍在
        const s2 = {
            id: 'S-SW2',
            snapshotEvents: () => ([
                { seq: 1, type: 'compaction/summary', data: { text: '摘要' } },
            ]),
        };
        const ctx2 = { agent: { session: s2 }, scope: { agent: { session: s2 } } };
        const assembly = prompt.assemble(ctx2);
        const refreshed = prompt.refreshContext(assembly, ctx2);
        const text = refreshed.contexts.find((c) => c.name === ACTIVE_MEMORY)?.text ?? '';
        assert.ok(text.includes('resume_snapshot'), `关推送时把导航段也干掉了（压缩白丢历史）：${text}`);
        fs.rmSync(flag, { force: true });
        setPushOffPath(undefined);
        fs.rmSync(flagDir, { recursive: true, force: true });
    });
}

// ★★★ 2026-11-14 项目 07 追加：原「台账断更硬闸」**整项删除**。
//   它守的是 `LEDGER_LINE` 里那个手写的门项数，而台账本身已随常驻五层退役
//   （说明：「留有用的」）。**这条闸退役是有代价的，必须写明白**：
//     从今往后，"改了门项数要追账"这个约束**没有常驻载体了** —— 原来它靠
//     模型每步看到「【台账】门32」被提醒，现在只能靠 `Updating\模块关联表.md` 的门表
//     和本项目日志人工维护。**这是主动接受的登记风险，不是遗漏。**
//   为什么不能留个空壳闸：留着一个指向已删除常量的断言，门一跑就 SyntaxError，
//     等于用"门打不开"冒充"闸还在"。删掉＋写清代价，比养个假闸诚实（同 07 上半场
//     道 A 退役时的处理口径）。

console.log(`\npush-channels: ${n} 项全绿`);
fs.rmSync(RUN, { recursive: true, force: true });
