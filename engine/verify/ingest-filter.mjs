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
 * verify/ingest-filter.mjs — 「入库筛选」判据（项目 07，2026-11-14）
 *
 * 干什么：把「谁的输出会入库、谁的不入、不入时怎么兜底」变成可跑的判据。
 *
 * 为什么要有它
 * ─────────────────────────────────────────────────────────
 * 修前入库只发生在 `ctx.run` 自己身上（`14-tools` 的 `INTENT_INDEX_BYTES = 5_000`）。
 * 宿主 `read` / `grep` / `pwsh` / MCP 的大输出**从不入库**，只被
 * `ours/output-containment.js` 砍成「头 6000 字符 + 尾 2000 字符 + 落盘 spill（20 个滚动淘汰）」
 * ⇒ 检索不到、14 天删线管不到、spill 一滚内容就永久没了。
 *
 * 本轮把第三方项目 context-mode 2.1.10 的 `PostToolUse` 路径搬了过来（**不搬网页抓取腿** ——
 * 本机网页搜索是 FP，见 07-立项书 §2.2）。判据分四组：
 *
 *   A. **谁入库**：非 `ctx` 的工具、超阈值 → 入库，回 source 标签 + 取回指路
 *   B. **四条豁免**：`ctx` 自己 / 带范围参数（**仅 read·view·edit**）/ agent 自己的规则文件 / 非纯文本
 *   C. **失败兜底**：引擎不可用 / 引擎报错 → 退回 head+tail+spill，且如实说明原因
 *   D. **预算**：回给模型的文本永远 ≤ `maxResultBytes`（历史教训：内层承诺 64KB、
 *      外层 40KB 先动手 = 说得出做不到）
 *
 * 判据姿势（§6.3 硬约束）：全部调**生产口** `installOutputContainment()`
 * 拿真 handler，再用**假 ctx.on** 把 handler 抓出来喂真形状的 exec；不 import 测试后门。
 *
 * 跑法：node engine/verify/ingest-filter.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);
const WORK = path.dirname(ENGINE);

/** 与 push-channels 同款布局探测（开发树 overlay/ vs 成品扁平）。 */
function resolveDir(name) {
    const flat = path.join(WORK, name);
    const overlaid = path.join(WORK, 'overlay', name);
    const hasFlat = fs.existsSync(flat);
    const hasOverlaid = fs.existsSync(overlaid);
    if (hasFlat && hasOverlaid) {
        throw new Error(`ingest-filter: ${name}/ 同时存在于 ${flat} 和 ${overlaid} —— 布局歧义`);
    }
    if (hasOverlaid) return overlaid;
    if (hasFlat) return flat;
    throw new Error(`ingest-filter: 找不到 ${name}/（试过 ${overlaid} 与 ${flat}）`);
}
const OVERLAY = resolveDir('ours');

const RUN = makeTempRunDir('ingest-filter');
releaseTempRunDir(RUN);
fs.mkdirSync(RUN, { recursive: true });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const { installOutputContainment, exemption, isOwnFile, toolLabel, __TRIGGER_DEFAULT, __RANGE_SCOPE } =
    await import(pathToFileURL(path.join(OVERLAY, 'output-containment.js')).href);

/**
 * 把生产 handler 抓出来。
 * @param {object} [options] 直接透传给 installOutputContainment
 * @returns {{handle: Function, dispose: Function, events: string[]}}
 */
function harness(options = {}) {
    let handler;
    const events = [];
    const fakeCtx = {
        on: (name, fn) => {
            events.push(name);
            handler = fn;
            return () => { };
        },
    };
    const dispose = installOutputContainment(fakeCtx, { spillDir: path.join(RUN, 'spill'), ...options });
    return { handle: handler, dispose, events };
}

/** 造一个宿主形状的 post-execute 入参。 */
function exec(name, args = {}) {
    return { name, arguments: args, session: { id: 's-ingest' } };
}

/** 造一条 accept 决议（含正文）。 */
function accept(text) {
    return { kind: 'accept', content: [{ type: 'text', text }] };
}

/** 走一遍生产 handler：next 返回 accept(text)。 */
async function run(handle, name, args, text) {
    return handle(exec(name, args), accept(text), async () => accept(text));
}

const BIG = 'X'.repeat(6_000);          // > 4096 触发阈值
const SMALL = 'Y'.repeat(100);          // < 阈值，不该被动

// ─────────────────────────────────────────────────────────
// A. 谁入库
// ─────────────────────────────────────────────────────────
t('A0 阈值默认 = 4096（第三方 /REPLACE_TRIGGER_BYTES 同口径；不是 ctx.run 的 5000）', () => {
    assert.equal(__TRIGGER_DEFAULT, 4096, `触发阈值漂了：${__TRIGGER_DEFAULT}`);
});

await ta('A0b 生产 handler 挂在 tools/post-execute（挂错事件 = 整条通道不生效）', async () => {
    const h = harness();
    assert.equal(typeof h.handle, 'function', 'install 没把 handler 挂上去');
    assert.deepEqual(h.events, ['tools/post-execute'], `挂错事件：${h.events}`);
    h.dispose();
});

await ta('A1 超阈值的**非 ctx** 工具输出 → 入库，回 source 标签 + 取回指路', async () => {
    const calls = [];
    const h = harness({
        callEngine: async (args) => {
            calls.push(args);
            return { content: [{ type: 'text', text: '已写入 tool:read:20261114T000000Z-abc123：7 块（其中代码 0）' }] };
        },
    });
    const out = await run(h.handle, 'read', { file_path: 'F:\\workspace\\x.txt' }, BIG);
    assert.equal(out.kind, 'accept', '决议被改成了非 accept');
    const text = out.content[0].text;
    // ★ 判据 1：引擎真被调了，且 args 是 index 形态
    assert.equal(calls.length, 1, `没调引擎入库（calls=${calls.length}）`);
    assert.equal(calls[0].op, 'index', `op 不是 index：${calls[0].op}`);
    assert.equal(calls[0].content, BIG, '入库内容不是原文（被截断后再入？）');
    assert.match(calls[0].source, /^tool:read:/, `source 标签前缀不对：${calls[0].source}`);
    assert.equal(calls[0].sessionId, 's-ingest', `sessionId 没传：${calls[0].sessionId}`);
    // ★ 判据 2：回执里必须给出**这个** source（能照着取回）
    assert.ok(text.includes(calls[0].source), `回执里没有 source 标签：${text}`);
    assert.ok(/recall/.test(text), '回执里没有 recall 指路');
    assert.ok(/full:true/.test(text), '回执里没说全文旁路');
    // ★ 判据 3：正文不许整份进对话（只留一小段预览）
    assert.ok(!text.includes('X'.repeat(2_000)), '正文被整份塞回对话（等于没省）');
    h.dispose();
});

await ta('A2 不超阈值 → 原样放行（不许动小输出）', async () => {
    const calls = [];
    const h = harness({ callEngine: async (a) => { calls.push(a); return { content: [{ type: 'text', text: '已写入' }] }; } });
    const out = await run(h.handle, 'grep', { pattern: 'x' }, SMALL);
    assert.equal(out.content[0].text, SMALL, '小输出被改写了');
    assert.equal(calls.length, 0, '小输出也去调引擎了 —— 每次都入库会把库撑爆');
    h.dispose();
});

// ─────────────────────────────────────────────────────────
// B. 四条豁免
// ─────────────────────────────────────────────────────────
await ta('B1 豁免①：`ctx` 自己的结果不入库（run 的 5KB 通道在引擎侧，不许双重入库）', async () => {
    const calls = [];
    const h = harness({ callEngine: async (a) => { calls.push(a); return { content: [{ type: 'text', text: '已写入' }] }; } });
    const out = await run(h.handle, 'ctx', { op: 'run' }, BIG);
    assert.equal(calls.length, 0, 'ctx 自己的输出又被入库了一遍（换了个 label = 库翻倍）');
    assert.equal(out.content[0].text, BIG, 'ctx 的结果被改写了');
    assert.equal(exemption(exec('ctx')), 'own-tool');
    h.dispose();
});

await ta('B2 豁免②：**读文件类工具**带 offset/limit/view_range 才放行（调用方点名要的就是那几行）', async () => {
    const calls = [];
    const h = harness({ callEngine: async (a) => { calls.push(a); return { content: [{ type: 'text', text: '已写入' }] }; } });
    for (const args of [{ file_path: 'F:\\x.txt', offset: 100 }, { file_path: 'F:\\x.txt', limit: 50 }, { file_path: 'F:\\x.txt', view_range: [1, 80] }, { file_path: 'F:\\x.txt', start_line: 3, end_line: 9 }]) {
        const out = await run(h.handle, 'read', args, BIG);
        assert.equal(out.content[0].text, BIG, `带范围参数却被改写了：${JSON.stringify(args)}`);
    }
    // view / edit 也在范围内（各自的键见 RANGE_SCOPE）
    const outV = await run(h.handle, 'view', { file_path: 'F:\\x.txt', view_range: [1, 80] }, BIG);
    assert.equal(outV.content[0].text, BIG, 'view 的 view_range 没被认作范围');
    const outE = await run(h.handle, 'edit', { file_path: 'F:\\x.txt', offset: 5 }, BIG);
    assert.equal(outE.content[0].text, BIG, 'edit 的 offset 没被认作范围');
    assert.equal(calls.length, 0, '带范围参数的读取仍被入库了 —— 把用户要的东西藏起来');
    h.dispose();
});

// ★ 2026-11-14 当场抓到的真漏洞（维护方问"FP 呢"才翻出来）
//   原判据是**全局键表**：参数里出现 `limit` 就豁免。于是 `fp({op:"search", limit:N, fullSnippet:true})`
//   被当成"点名要范围"整份灌进对话。而 `fp.limit` 是**交付条数上限**——
//   FP 自己的 `05-outgate` 记着实测：`limit:500 + fullSnippet:true` 单次交付 **327,756 字节**，
//   正好绕过入库。修法：`RANGE_SCOPE` 先认工具名再认键（fp/grep/run 一律不认）。
await ta('B5 豁免② 不许泛化到非读文件工具：`fp` 带 limit **必须入库**（原漏洞，327 KB 能整份灌进对话）', async () => {
    const calls = [];
    const h = harness({ callEngine: async (a) => { calls.push(a); return { content: [{ type: 'text', text: '已写入 tool:fp:x：3 块' }] }; } });
    const ARGS = [
        { op: 'search', query: 'sqlite fts5', limit: 12, fullSnippet: true },  // ← 原漏洞主样本
        { op: 'search', query: 'x', limit: 500, fullSnippet: true },           // ← 327 KB 那条
        { op: 'fetch', url: 'https://a.b/c', maxBytes: 1_000_000 },
        { op: 'doctor' },
    ];
    for (const args of ARGS) {
        const out = await run(h.handle, 'fp', args, BIG);
        assert.notEqual(out.content[0].text, BIG, `fp 带 ${Object.keys(args)} 被整个放行了 —— 没有入库`);
    }
    assert.equal(calls.length, ARGS.length, `fp 该入库 ${ARGS.length} 次，实际 ${calls.length} 次`);
    for (const c of calls) {
        assert.equal(c.op, 'index');
        assert.match(c.source, /^tool:fp:/, `fp 的 source 标签前缀不对：${c.source}`);
    }
    // 判据直说：fp 的 limit 不是行号范围
    assert.equal(exemption(exec('fp', { op: 'search', limit: 12 })), null, 'fp.limit 又被当成范围豁免了');
    h.dispose();
});

await ta('B6 豁免② 的作用面由 `__RANGE_SCOPE` 钉死：只有 read/view/edit，写入工具不在表里', async () => {
    assert.deepEqual(
        Object.keys(__RANGE_SCOPE).sort(),
        ['edit', 'read', 'view'],
        `范围豁免的工具面漂了：${Object.keys(__RANGE_SCOPE)}`,
    );
    // 反向防恒真：这仨必须**真在**表里（否则 B2 就成了空转）
    for (const name of ['read', 'view', 'edit']) {
        assert.ok(Array.isArray(__RANGE_SCOPE[name]) && __RANGE_SCOPE[name].length > 0, `${name} 的键表空了`);
    }
    // grep 的 limit 同理不是行号范围
    assert.equal(exemption(exec('grep', { pattern: 'x', limit: 5 })), null, 'grep.limit 被当成范围豁免了');
});

await ta('B3 豁免③：agent 自己的 instruction / skill 文件放行（规则本身必须原样可见）', async () => {
    const calls = [];
    const h = harness({ callEngine: async (a) => { calls.push(a); return { content: [{ type: 'text', text: '已写入' }] }; } });
    const OWN = [
        'F:\\workspace\\AGENTS.md',
        'C:\\Users\\x\\.dsh\\AGENTS.md',
        'F:\\proj\\CLAUDE.md',
        'F:\\proj\\GEMINI.md',
        'F:\\proj\\QWEN.md',
        'F:\\proj\\.github\\copilot-instructions.md',
        'F:\\proj\\skills\\ctx-op-run\\SKILL.md',
        'F:\\proj\\.kiro\\steering\\a.md',
    ];
    for (const p of OWN) {
        assert.equal(isOwnFile(p), true, `没认出是自己的规则文件：${p}`);
        const out = await run(h.handle, 'read', { file_path: p }, BIG);
        assert.equal(out.content[0].text, BIG, `规则文件被入库改写：${p}`);
    }
    assert.equal(calls.length, 0, '规则文件被入库了 —— 模型看不到原文就守不了规矩');
    // 反向：普通 .md 不是规则文件（防恒真）
    assert.equal(isOwnFile('F:\\proj\\Docs\\某个设计稿.md'), false, '普通 md 被误判成规则文件');
    h.dispose();
});

await ta('B4 豁免④：含非文本块的结果放行（图片/混合块不许被改写）', async () => {
    const h = harness({ callEngine: async () => { throw new Error('不该被调'); } });
    const mixed = { kind: 'accept', content: [{ type: 'text', text: BIG }, { type: 'image', data: 'xxx' }] };
    const out = await h.handle(exec('read', { file_path: 'F:\\a.png' }), mixed, async () => mixed);
    assert.equal(out, mixed, '含非文本块的结果被改写了');
    h.dispose();
});

// ─────────────────────────────────────────────────────────
// C. 失败兜底（no cut without index 的反面：库不可用时不许让内容凭空消失）
// ─────────────────────────────────────────────────────────
await ta('C1 引擎抛错 → 退回 head+tail+spill，并**如实说明为什么截断**', async () => {
    const h = harness({ callEngine: async () => { throw new Error('引擎未就绪（EngineClient 还没建好）'); } });
    const out = await run(h.handle, 'read', { file_path: 'F:\\big.txt' }, BIG);
    const text = out.content[0].text;
    assert.match(text, /没进成库/, `没说明截断原因（模型会以为文件就这么长）：${text.slice(0, 200)}`);
    assert.match(text, /引擎未就绪/, '没把引擎的具体错误带出来');
    assert.match(text, /全文已落盘/, '落盘了却没给路径');
    const m = /全文已落盘：(.+)/.exec(text);
    assert.ok(m !== null, '找不到落盘路径');
    assert.ok(fs.existsSync(m[1].trim()), `落盘文件不存在：${m[1]}`);
    assert.equal(fs.readFileSync(m[1].trim(), 'utf8'), BIG, '落盘内容不是原文');
    h.dispose();
});

await ta('C2 引擎回 isError → 同样兜底，且把引擎的一句话原因带上', async () => {
    const h = harness({ callEngine: async () => ({ isError: true, content: [{ type: 'text', text: 'NO_INPUT: content 只有空白' }] }) });
    const out = await run(h.handle, 'pwsh', { command: 'dir' }, BIG);
    const text = out.content[0].text;
    assert.match(text, /入库被引擎拒绝/, '没说"被拒"');
    assert.match(text, /NO_INPUT/, '没带引擎的错误码');
    h.dispose();
});

await ta('C3 没有接引擎口（装配层没给 callEngine）→ 兜底且说明"本包没接入库通道"', async () => {
    const h = harness({});
    const out = await run(h.handle, 'read', { file_path: 'F:\\big.txt' }, BIG);
    const text = out.content[0].text;
    assert.match(text, /本包没有接入库通道/, `没说明原因：${text.slice(0, 160)}`);
    h.dispose();
});

await ta('C4 别的监听器已 deny → 本件不许改写别人的决议', async () => {
    const h = harness({ callEngine: async () => { throw new Error('不该被调'); } });
    const DENY = { kind: 'deny', reason: '别人正在改' };
    const out = await h.handle(exec('read', { file_path: 'F:\\x.txt' }), accept(BIG), async () => DENY);
    assert.deepEqual(out, DENY, `deny 被改写成了 ${JSON.stringify(out)}`);
    h.dispose();
});

// ─────────────────────────────────────────────────────────
// D. 预算（说得出 vs 做得到）
// ─────────────────────────────────────────────────────────
await ta('D1 入库成功的回执 ≤ maxResultBytes（含预览与指路，全部计入）', async () => {
    const LIMIT = 4_096;
    const h = harness({
        maxResultBytes: LIMIT,
        callEngine: async () => ({ content: [{ type: 'text', text: '已写入 tool:read:20261114T000000Z-abc：9 块' }] }),
    });
    const out = await run(h.handle, 'read', { file_path: 'F:\\huge.txt' }, BIG);
    const bytes = Buffer.byteLength(out.content[0].text, 'utf8');
    assert.ok(bytes <= LIMIT, `回执 ${bytes} B > 预算 ${LIMIT} B`);
    h.dispose();
});

await ta('D2 兜底回执的**骨架**必须在预算内（head/tail 可被预算压，但指路行不许丢）', async () => {
    const h = harness({ maxResultBytes: 2_000, callEngine: async () => { throw new Error('boom'); } });
    const out = await run(h.handle, 'read', { file_path: 'F:\\huge.txt' }, BIG);
    const text = out.content[0].text;
    assert.match(text, /没进成库/, '兜底文案丢了原因行');
    assert.match(text, /全文已落盘/, '兜底文案丢了落盘路径行');
    h.dispose();
});

await ta('D3 source 标签唯一（同一次会话连续两次同工具，标签不许撞 —— 撞了就 by-label 覆盖）', async () => {
    const h = harness({ callEngine: async () => ({ content: [{ type: 'text', text: '已写入' }] }) });
    const labels = [];
    for (let i = 0; i < 5; i += 1) {
        const l = toolLabel(exec('read', { file_path: 'F:\\x.txt' }));
        labels.push(l);
        await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(new Set(labels).size, 5, `5 次起了 ${new Set(labels).size} 个唯一标签 —— 会互相覆盖`);
    assert.ok(labels.every((l) => /^tool:read:/.test(l)), `标签形状不对：${labels}`);
    h.dispose();
});

// ─────────────────────────────────────────────────────────
// E. 与 ctx.run 通道不重叠（两条通道各管各的工具面）
// ─────────────────────────────────────────────────────────
await ta('E1 ctx.run 的 5KB 通道不受影响（本件不改 14-tools 的阈值）', () => {
    const src = fs.readFileSync(path.join(ENGINE, 'blocks', '14-tools', 'index.js'), 'utf8');
    assert.ok(/INTENT_INDEX_BYTES = 5_000/.test(src), 'ctx.run 的 5000 阈值被改了（维护方 2026-11-02 定案）');
    const ocRaw = fs.readFileSync(path.join(OVERLAY, 'output-containment.js'), 'utf8');
    assert.ok(/TRIGGER_DEFAULT = 4_096/.test(ocRaw), '新通道阈值不是 4096');
    // 两条通道各自的阈值必须在**各自的件**里（同一个数值散两处 = 迟早漂移）。
    // ★ 只看代码行：本件注释里为了讲清"为什么是两套阈值"必然要提 ctx.run 的 5000，
    //   把注释算进来等于禁止解释 —— 那是把判据写成"不许写注释"。
    const oc = ocRaw
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join('\n');
    assert.ok(!/INTENT_INDEX_BYTES/.test(oc), 'output-containment 的**代码行**里出现了 ctx.run 的常量 —— 两条通道糊在一起了');
});

// ─────────────────────────────────────────────────────────
// F. 门自己不许假绿（2026-11-14 当场抓到的一次）
//
//   本轮第一版把这个文件里 15 个 `ta(...)` 全写成了没有 `await` 的调用，
//   于是断言还在飞、脚本已经一路跑到底并打出"全绿 EXIT=0"——
//   **门看着绿，实际一条没验**。这正是 §6.3 说的"错的判据抢着报绿"。
//   判据：本文件里每个 `ta(` 调用都必须带 `await`（静态自检，跑在最后）。
// ─────────────────────────────────────────────────────────
t('F1 假绿自检：本文件每个 `ta(` 都必须带 `await`（否则断言在飞、门已绿）', () => {
    const self = fileURLToPath(import.meta.url);
    const src = fs.readFileSync(self, 'utf8');
    const bad = [];
    for (const line of src.split('\n')) {
        const t2 = line.trim();
        if (!t2.startsWith('ta(')) continue;
        bad.push(t2.slice(0, 60));
    }
    assert.deepEqual(bad, [], `这些 ta( 调用没带 await —— 门会在断言完成前就打出全绿：\n${bad.join('\n')}`);
    // ★ 反向防恒真：本文件里必须**确实有** await ta(
    const nAwait = (src.match(/^await ta\(/gm) ?? []).length;
    assert.ok(nAwait >= 10, `只找到 ${nAwait} 个 await ta( —— 判据可能写错了（本门应 ≥16 项）`);
});

console.log(`\ningest-filter: ${n} 项全绿`);
fs.rmSync(RUN, { recursive: true, force: true });
