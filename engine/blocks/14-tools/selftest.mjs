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
 * 14-tools/selftest.mjs — 单跑必绿
 *
 * 测什么：① 13 个 op 全注册 ② 真分派（registry.dispatch 能到各 op，不是壳里 switch）
 *        ③ 描述 ≤1563B ≈300 token 且自带 op 表 ④ 错误第一行是"怎么改" ⑤ schema 可结构化克隆
 *        ⑥ 不传 op 返回自描述表 ⑦ 真删要 dryRun:false ⑮ recall 并入 op 后仍真分派
 *        ★ 2026-11-09 ④步 CTX 净身：① 的 14 改 13（净身版 §三-4 明文点到的文案面之一）。
 */
import assert from 'node:assert/strict';
import { createTools, CTX_RUN_DESCRIPTION, loadDescription, opsDeclaredIn, DESCRIPTION_FILE } from './index.js';
import { createRegistry } from '../../registry.mjs';

let n = 0;
/** 抓异步抛出的错误（壳的 call 都是 async）。 */
async function catchErr(fn) {
    try { await fn(); return null; } catch (e) { return e; }
}

// ── 假依赖：足够跑通壳的分派，不接真库 ──
const registry = createRegistry({ level: 'error' });
const fakeWriter = { write: (o) => ({ sourceId: 1, label: o.source ?? 'x', totalChunks: 2, codeChunks: 0 }) };
const fakeReader = {
    search: ({ query }) => [{ title: 't1', content: `命中 ${query}`, source: 's1', rank: -1, contentType: 'prose', highlighted: '', sessionId: '' }],
    getStats: () => ({ sources: 1, chunks: 2, codeChunks: 0 }),
    getIndexState: () => ({ totalChunks: 2, totalSources: 1 }),
    getSourceIdByLabel: (l) => (l === 's1' ? 1 : null),
    getChunksBySource: () => [{ title: 't1', content: '块一' }, { title: 't2', content: '块二' }],
    listSources: () => [{ label: 's1', chunkCount: 2 }],
};
const fakeMemory = {
    remember: (a) => ({ id: 7, label: a.label ?? 'remember:x', category: a.category }),
    pin: (a) => ({ id: 8, label: a.label, fromChunks: a.chunks.length, mergedBytes: 20 }),
    unpin: (a) => ({ label: a.label, content: '正文', released: true }),
    list: () => [{ id: 7, title: 'T', category: 'C', label: 'L', createdAt: 'x' }],
    get: (id) => ({ id, title: 'T', content: 'C', category: 'Cat', label: 'L' }),
    setCategory: (a) => ({ id: a.id, category: a.category }),
    remove: (a) => ({ id: a.id, deleted: true }),
    stats: () => ({ rows: 1, bytes: 10, limit: 65536, categories: ['C'] }),
};
const fakeLifecycle = {
    plan: () => ({ days: 14, wouldDeleteSources: 2, wouldDeleteChunks: 5, oldest: '2026-10-01', samples: [] }),
    retention: () => ({ days: 14, deletedSources: 2, deletedChunks: 5, deletedTrigram: 5, dryRun: false }),
    optimize: () => ({ optimized: true }),
    checkpoint: (m) => ({ mode: m, result: [] }),
    integrityCheck: () => ({ ok: true, sqlite: 'ok', fts5: 'ok', action: 'never-auto-rebuild' }),
    vacuum: (o) => (o?.dryRun === false ? { vacuumed: true, beforeBytes: 1, afterBytes: 1 } : { dryRun: true, reclaimableBytes: 100, fileBytes: 200 }),
    doctor: () => ({ checks: [{ name: 'journal_mode=WAL', ok: true, detail: 'wal', fix: 'x' }], failed: 0, total: 1 }),
    fileBytes: () => 200,
};
const fakeSandbox = {
    run: async ({ code }) => ({ stdout: `跑了 ${code}`, stderr: '', exitCode: 0, truncated: false, bytes: 5 }),
    runBatch: async ({ commands }) => ({ runs: commands.map((c) => ({ stdout: c })) }),
    runFile: async ({ file }) => ({ stdout: `FILE ${file}`, exitCode: 0 }),
};
const fakeRecall = {
    // ★ 2026-11-14（项目 07）：道 A 退役，`_state()` 里只剩 `seenB`。
    //   本文件 ⑬ 专门断言"stats 不许回退读它"——留着这个假件是为了让那条断言有意义。
    _state: () => ({ seenB: 0 }),
    // ★ 乙档：op:recall 现在真的调席位制合并（长久库 ≤2 席先占）
    mergeWithMemory: (tempResults, memoryRows, opts) => {
        const seats = opts?.memorySeats ?? 2;
        const mem = (memoryRows ?? []).slice(0, seats).map((m) => ({
            title: m.title, content: '', source: m.label, rank: 0, contentType: 'prose',
            highlighted: '', timestamp: undefined, sessionId: '', store: 'memory',
        }));
        return [...mem, ...(tempResults ?? []).map((r) => ({ ...r, store: 'temp' }))];
    },
};

const tools = createTools({
    registry, writer: fakeWriter, reader: fakeReader, memory: fakeMemory,
    lifecycle: fakeLifecycle, sandbox: fakeSandbox, recall: fakeRecall,
});

const t = async (name, fn) => { try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n      ${e?.message ?? e}`); process.exitCode = 1; } };

// ★ 2026-11-09 ④步 CTX 净身：14 → 13（op:search 整条迁 FP，净身版 §三-4）。
//   **禁连坐**：本文件其余 "14" 若属块名(14-tools)/保留天数(14 天)一律不动。
await t('① 13 个 op 全注册（…maint/purge/switch/list；switch 于 2026-11-05 新增；search 于 2026-11-09 迁 FP）', () => {
    const want = ['run', 'recall', 'index', 'remember', 'pin', 'unpin', 'memory', 'stats', 'doctor', 'maint', 'purge', 'switch', 'list'];
    assert.deepEqual(tools.ops(), want, `实际 ${tools.ops()}`);
});

await t('② 每个 op 都进了 registry（真分派，不是壳里 switch）', () => {
    for (const op of tools.ops()) {
        assert.ok(registry.toolList().some((x) => x.op === op), `${op} 没进 registry`);
    }
    assert.equal(registry.opCount(), 13);
});

await t('③ 描述 ≤1563B ≈300 token 且自带 op 表（模型没有 13 个独立 schema 可看）', () => {
    const bytes = Buffer.byteLength(CTX_RUN_DESCRIPTION);
    assert.ok(bytes <= 1563, `描述 ${bytes} B > 1563 B（≈300 token）`);
    for (const op of ['run', 'recall', 'index', 'remember', 'pin', 'unpin', 'memory', 'stats', 'doctor', 'maint', 'purge', 'switch']) {
        assert.ok(CTX_RUN_DESCRIPTION.includes(op), `描述里缺 ${op}`);
    }
});

await t('③b 描述真源是 descriptions/ctx.md（文案面进 .md，2026-11-04 设计确定：）', () => {
    // 直接测加载器本身：读文件 == 模块常量（有人把文案改回硬编码就会红）
    const fresh = loadDescription();
    assert.equal(fresh, CTX_RUN_DESCRIPTION, '模块常量与 ctx.md 现读不一致 —— 加载器被旁路了？');
    assert.ok(fresh.startsWith('Example:'), '2.0 形态倒序：第一行必须是 Example（模型第一眼要能抄一句调用）');
    // 缺文件必须抛（不许静默退 JS 常量）
    let threw = null;
    try { loadDescription(DESCRIPTION_FILE + '.missing'); } catch (e) { threw = e; }
    assert.ok(threw && /文案文件读不到/.test(threw.message), '缺 ctx.md 竟然没抛：静默退化是漂移的温床');
});

await t('③c ctx.md 的 op 行与注册表一一对应（漂移=装配抛，这里验两条方向都堵）', () => {
    const declared = opsDeclaredIn(CTX_RUN_DESCRIPTION);
    assert.deepEqual([...tools.ops()].sort(), [...declared].sort(),
        '注册表与文案漂移 —— 模型会看到不存在的 op 或看不见真实存在的 op');
});

await t('④ registry.dispatch 真能调通 op（壳只做转发）', async () => {
    const out = await registry.dispatch('index', { content: '# 甲', source: 's1' });
    assert.equal(out.result.label, 's1');
    assert.ok(out.text.includes('14 天缓存'));
});

await t('⑤ 错误第一行是"怎么改"（err.js 契约）', async () => {
    const e = await catchErr(() => tools.get('index').call({}));
    assert.equal(e?.code, 'NO_INPUT', `实际 ${e?.code}`);
    assert.ok(e.message.split('\n')[0].length > 10, e.message);
});

await t('⑥ 三选一互斥：path + content 同时给 → ONE_OF_INPUT', async () => {
    const e = await catchErr(() => tools.get('index').call({ path: 'a', content: 'b' }));
    assert.equal(e?.code, 'ONE_OF_INPUT', `实际 ${e?.code}`);
});

await t('⑦ 不传 op = list：返回自描述表 13 行', async () => {
    const out = await tools.get('list').call({});
    assert.equal(out.result.length, 13);
});

await t('⑧ maint retention 不给 dryRun:false → 只干跑报数（假开关教训）', async () => {
    const out = await tools.get('maint').call({ action: 'retention', days: 14 });
    assert.ok(out.text.includes('干跑'), out.text);
    assert.ok(out.text.includes('dryRun:false'));
});

await t('⑨ maint retention + dryRun:false → 真删', async () => {
    const out = await tools.get('maint').call({ action: 'retention', days: 14, dryRun: false });
    assert.ok(out.text.includes('已真删'), out.text);
});

await t('⑩ doctor fix:true 只做可逆维护（optimize+checkpoint）', async () => {
    const out = await tools.get('doctor').call({ fix: true });
    assert.deepEqual(out.result.fixed, ['optimize', 'checkpoint(PASSIVE)']);
});

await t('⑪ 每个 op 的 schema 都能结构化克隆（1.2.2 事故护栏）', () => {
    const clone = JSON.parse(JSON.stringify({ ops: tools.opTable() }));
    for (const o of clone.ops) {
        assert.equal(typeof o.op, 'string');
        assert.equal(typeof o.required, 'string');
        assert.equal(typeof o.oneLine, 'string');
    }
});

await t('⑫ pin 走 reader 拿块（多块合并成一行）', async () => {
    const out = await tools.get('pin').call({ label: 's1', category: '踩坑/甲' });
    assert.equal(out.result.fromChunks, 2);
});

await t('⑬ stats 汇总库 + 长久库；hints 只在装配层注入了真池时才报', async () => {
    const out = await tools.get('stats').call({});
    assert.ok(out.result.db && out.result.memory);
    // ★★ 2026-11-14（项目 07）：道 A 摘除后，`hints` **不再回退**读 `10-recall._state()`。
    //   没注入 `hintState`（引擎独立跑 / 假件）→ 这一行就没有，而不是报一份死数。
    //   历史：修前这里恒有值，回退口是 `deps.recall._state()`（生产上零调用方，seenA 恒 0）。
    assert.equal(out.result.hints, undefined, 'hints 又出现了 —— 回退读死数的口被复活了');
    assert.equal(out.result.hintsSource, undefined, 'hintsSource 又出现了');
});

await t('⑬b 注入了真池（道 B 的 playbackState）→ hints 报出来且来源写明', async () => {
    const t2 = createTools({
        registry, writer: fakeWriter, reader: fakeReader, memory: fakeMemory,
        lifecycle: fakeLifecycle, sandbox: fakeSandbox, recall: fakeRecall,
        hintState: () => ({ seenB: 3, playback: 1 }),
    });
    const out = await t2.get('stats').call({});
    assert.equal(out.result.hints.seenB, 3);
    assert.match(out.result.hintsSource, /道B/, `hintsSource 应说明是道 B：${out.result.hintsSource}`);
});

await t('⑭ run op 能转发到 sandbox 并回 stdout', async () => {
    const out = await tools.get('run').call({ language: 'javascript', code: 'console.log(1)' });
    assert.ok(out.text.includes('跑了'), out.text);
});

// ─── ⑯-㉑ P3（沙箱归一）：run 收敛归位 / 报错分型 / SSRF 闸 / url 字符串修复 ───

/** 造一份记录调用的假依赖（P3 判据专用，不动上面共享的假件）。 */
function makeRecorder() {
    const calls = [];
    return {
        calls,
        writer: { write: (o) => { calls.push(['write', o]); return { sourceId: 1, label: o.source, totalChunks: 3, codeChunks: 0 }; } },
        reader: { search: (q) => { calls.push(['search', q]); return [{ title: '块A', content: 'AAA'.repeat(50), source: q.source, rank: -1, contentType: 'prose', highlighted: '', sessionId: '' }]; } },
        sandbox: {
            run: async (o) => { calls.push(['run', o]); return { stdout: o.echo ?? '跑了 ' + o.code, stderr: '', exitCode: 0, truncated: false, bytes: 5 }; },
            runBatch: async (o) => ({ runs: o.commands }),
        },
    };
}

await t('⑯ 大输出无 intent → 整份入库 + 回定位符（no cut without index）', async () => {
    const rec = makeRecorder();
    const ts2 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });
    const big = 'x'.repeat(6000);
    const out = await ts2.get('run').call({ code: big, echo: big });
    assert.ok(rec.calls.some((c) => c[0] === 'write'), '超过 16KB 预算的输出必须整份入库，不许静默截丢');
    assert.ok(out.text.includes('run:javascript:'), `定位符要可寻址：${out.text.slice(0, 120)}`);
    assert.ok(out.text.includes('op:"recall"'), '要给出取回方法');
    assert.ok(!out.text.includes(big), '正文不许进对话');
});

await t('⑰ intent + >5KB → 选整块回文本，不是一刀截', async () => {
    const rec = makeRecorder();
    const ts2 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });
    const big = 'y'.repeat(6000);
    const out = await ts2.get('run').call({ code: big, echo: big, intent: '错误行' });
    assert.ok(out.text.includes('Intent containment'), out.text.slice(0, 120));
    assert.ok(out.text.includes('AAA'.repeat(10)), 'intent 命中的整块要进正文（块是假 reader 给的）');
    assert.ok(rec.calls.some((c) => c[0] === 'search'), 'intent 要真的去查库选块');
});

await t('⑱ 报错分型：只给 file / code+commands 同给 / 空 code，各有专属文案', async () => {
    const rec = makeRecorder();
    const ts2 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });
    const e1 = await catchErr(() => ts2.get('run').call({ file: 'a.txt' }));
    assert.equal(e1?.code, 'NO_INPUT');
    assert.ok(e1.message.includes('CTX_FILE'), '只给 file 的报错要讲清 file 语义：' + e1.message);
    const e2 = await catchErr(() => ts2.get('run').call({ code: 'x', commands: ['ls'] }));
    assert.equal(e2?.code, 'ONE_OF_INPUT', `code+commands 互斥：${e2?.code}`);
    const e3 = await catchErr(() => ts2.get('run').call({ code: '   ' }));
    assert.equal(e3?.code, 'NO_INPUT');
});

await t('⑲ sandbox 结构化失败（ok:false）要带着 code 抛给模型', async () => {
    const rec = makeRecorder();
    rec.sandbox.run = async () => ({ ok: false, code: 'LANGUAGE_NOT_CONFINABLE', message: '受限只放 javascript', fix: '改 pwsh' });
    const ts2 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });
    const e = await catchErr(() => ts2.get('run').call({ code: 'x', language: 'shell' }));
    assert.equal(e?.code, 'LANGUAGE_NOT_CONFINABLE', `实际 ${e?.code}`);
    assert.ok(e.message.includes('pwsh'), e.message);
});

await t('⑳ run 把 signal/session 透传到 sandbox（P2 链在 op 层的一环）', async () => {
    const rec = makeRecorder();
    const ts2 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });
    const ac = new AbortController();
    await ts2.get('run').call({ code: 'x' }, { signal: ac.signal, session: { id: 's-42' } });
    const runCall = rec.calls.find((c) => c[0] === 'run');
    assert.equal(runCall[1].signal, ac.signal, '取消通道断在 14-tools 就等于没接');
    assert.equal(runCall[1].session?.id, 's-42');
});

// ★ 2026-11-09 ④步 CTX 净身（净身版 §三-16）：原 ㉑ 是**经 index{url} 入口**测 SSRF 闸
//   （拦下 + never 触网 + 公网放行 + 正文字符串入库）。index{url} 与 op:search 双双迁 FP 后，
//   CTX 侧**已无触网入口**，原判据失去被测对象（不是"功能坏了"，是"这条路搬走了"）。
//   按净身版裁决：**改纯词法断言** —— `url-guard` 是纯同步零副作用模块（不发请求），
//   私网/环回/metadata/非 http(s) 直接抛 `URL_BLOCKED`，完全可以脱离入口单测。
//   覆盖转移账（不粉饰）：CTX 侧"拦截→绝不触网→公网放行→正文入库"这条**端到端回归归零随迁 FP**，
//   FP 必须自建等价门（⑤步账，见净身版 §三-16 覆盖转移账）。CTX 侧只保留"词法规则本身还对"。
// ★★ C-1 / A-10（2026-11-09 ④步 CTX 净身，净身版 §一 C-1 + §三-3 第①条改写口径）：
//   原 A-10 三条验收判据里的第①条是 `engines:["zzz"]` 回归 —— 那是 **op:search 的参数**，
//   随 search 迁走后必须改写成"**对 CTX 现存数组参数（`queries[]`、`commands[]`）**同型测试"。
//   依据 N-①：宿主→工具面参数送达变形属宿主段，拆插件治不了，CTX 与 FP 各自必修。
//   这里钉死"三认"（真数组 / JSON 数组字符串 / 单字符串）在**两个现存数组入口**上都成立。
await t('㉒ C-1 参数宽容三认：commands[]/queries[] 认数组、JSON 串、单串（A-10 ①改写）', async () => {
    const rec = makeRecorder();
    const ts3 = createTools({ registry: createRegistry({ level: 'error' }), writer: rec.writer, reader: rec.reader, memory: fakeMemory, lifecycle: fakeLifecycle, sandbox: rec.sandbox, recall: fakeRecall });

    // 判据读法说明：recorder 的 runBatch 不往 calls 里记（它只回 `{runs: o.commands}`），
    // 所以这里**读返回值**——`result.runs` 就是规整后真正交给 sandbox 的命令数组。
    // 「没走到 runBatch」= 抛错（掉进缺参/形状闸），用 catchErr 抓。

    // ① 真数组（基线：本来就能过）
    {
        const out = await ts3.get('run').call({ op: 'run', commands: ['echo a', 'echo b'] });
        assert.deepEqual(out.result.runs, ['echo a', 'echo b'], '真数组应原样两条');
    }

    // ② JSON 数组字符串（宿主/调用方把数组拍成串的形态）
    {
        const out = await ts3.get('run').call({ op: 'run', commands: '["echo a","echo b"]' });
        assert.deepEqual(out.result.runs, ['echo a', 'echo b'], 'JSON 串应还原成两条，不是当一条执行');
    }

    // ③ 单个字符串（一批只有一条的合法写法）
    {
        const out = await ts3.get('run').call({ op: 'run', commands: 'echo hi' });
        assert.deepEqual(out.result.runs, ['echo hi'], '单串应包成一项');
    }

    // ④ 坏 JSON **不许**降级成单条命令（静默执行错命令比报错更坏）
    {
        const eBad = await catchErr(() => ts3.get('run').call({ op: 'run', commands: '["a","b"' }));
        assert.ok(eBad, '坏 JSON 应当报缺参/形状错，不许静默当单条跑');
    }

    // ⑤ 嵌套数组仍要按 BAD_BATCH_SHAPE 拒（宽容层还原成数组，但**不替形状闸做判据**）
    {
        const eNest = await catchErr(() => ts3.get('run').call({ op: 'run', commands: [['a', 'b']] }));
        assert.equal(eNest?.code, 'BAD_BATCH_SHAPE', `嵌套数组应拒，实际 ${eNest?.code}`);
    }

    // ⑥ A-10 第②条「同参连跑 10 次一致」（原件 §11.3 A-10 行完整要求；10d665b9 复核抓出漏项后补）
    //   为什么要这条：参数宽容层如果有隐藏状态（缓存、一次性消费、随机顺序），
    //   单次跑看不出，连跑才会暴露"第二次开始结果就变了"。这正是 §四-4⑥「状态中性回归」的落点：
    //   **凡引入模块级状态的改动，回归前先复位/显式 seed，防"测的是历史恰好是什么"**。
    //   这里不留状态：每次调用都从同一份入参独立推结果，10 次必须全等。
    {
        const seen = [];
        for (let i = 0; i < 10; i++) {
            const out = await ts3.get('run').call({ op: 'run', commands: '["echo a","echo b"]' });
            seen.push(JSON.stringify(out.result.runs));
        }
        const uniq = [...new Set(seen)];
        assert.equal(uniq.length, 1, `同参连跑 10 次应完全一致，实际出现 ${uniq.length} 种结果：${uniq.join(' / ')}`);
        assert.equal(seen[0], JSON.stringify(['echo a', 'echo b']), '连跑结果应与单次一致');
    }

    // ── queries[] 三认（既有能力，同型回归：证明两个数组入口口径一致）──
    for (const q of [['甲', '乙'], '["甲","乙"]', '甲']) {
        const out = await tools.get('recall').call({ op: 'recall', queries: q });
        assert.ok(out.result.hits, `queries=${JSON.stringify(q)} 应当能召回`);
    }
});

await t('㉑ SSRF 闸（词法级）：内网/metadata/非 http(s) 一律 URL_BLOCKED；公网放行', async () => {
    const { assertSafeUrl } = await import('../../libs/url-guard.js');
    for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/x', 'file:///C:/secrets', 'http://localhost/admin', 'http://10.0.0.5/']) {
        const e = await catchErr(async () => assertSafeUrl(bad));
        assert.equal(e?.code, 'URL_BLOCKED', `${bad} 应当被拦，实际 ${e?.code}`);
    }
    // 公网必须放行（判据反向：全拦 = 闸写坏了）
    assert.equal(assertSafeUrl('https://example.com/doc'), 'https://example.com/doc', '公网地址要原样放行');
    // 纯词法断言：该模块零网络副作用，上面 6 条不发任何请求（无 web/deps 注入也能跑 = 证据）
});

await t('⑮ recall op 走 reader.search 真分派（并入壳之前它是独立工具位）', async () => {
    const out = await tools.get('recall').call({ queries: ['僵尸进程'] });
    assert.ok(out.result.hits, JSON.stringify(out).slice(0, 80));
    const e = await catchErr(() => tools.get('recall').call({}));
    assert.equal(e?.code, 'NO_QUERY', `实际 ${e?.code}`);
});

// ── 乙档三条判据（2026-11-04）──
await t('⑯ ★ 批查询**每问一节、取并集**（不是 join 成一串 AND）', async () => {
    const calls = [];
    const rd = {
        search: ({ query, limit }) => {
            calls.push(query);
            // 每问各回一条不同来源：并集必须两条都在
            return [{ title: `T-${query}`, content: `正文含 ${query} 的一段`, source: `src-${query}`, rank: 0, contentType: 'prose', highlighted: '', sessionId: '' }].slice(0, limit);
        },
        touchAccessed: () => 0,
        getSourceIdByLabel: () => null,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const out = await ts.get('recall').call({ queries: ['结论', '约束'] });
    assert.equal(calls.length, 2, `reader.search 应被调 2 次（每问一次），实际 ${calls.length}：${calls.join('|')}`);
    assert.deepEqual(calls, ['结论', '约束'], `每问必须原样传，不许拼串：${calls.join('|')}`);
    // 两问各一节
    assert.equal(out.result.sections.length >= 2, true, `应至少 2 节，实际 ${out.result.sections.length}`);
    assert.ok(out.text.includes('结论') && out.text.includes('约束'), '并集两问都要出现');
});

await t('⑰ ★ 回文本**窗口化**（长正文不许全量塞回模型）', async () => {
    const longText = `${'填充句子。'.repeat(400)}命中词在这里。${'尾部内容。'.repeat(400)}`;
    assert.ok(Buffer.byteLength(longText, 'utf8') > 8000, '夹具本身要够长');
    const rd = {
        search: () => [{
            title: '长块', content: longText, source: 'long-src', rank: 0, contentType: 'prose',
            highlighted: longText,   // ← 故意给全量 highlight（旧实现会原样吐回去）
            sessionId: '',
        }],
        touchAccessed: () => 0,
        getSourceIdByLabel: () => null,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const out = await ts.get('recall').call({ queries: ['命中词'] });
    const bytes = Buffer.byteLength(out.text, 'utf8');
    assert.ok(bytes < 4000, `回文本 ${bytes} B —— 窗口化没生效（旧版单条 4090 B）`);
    assert.ok(out.text.includes('命中词'), '窗口必须落在命中位置上');
});

await t('⑱ ★ 长久库**席位制**（≤2 席先占，久经验要能出现在结果里）', async () => {
    const rd = {
        search: () => [{ title: '临时块', content: '临时库正文', source: 'temp-src', rank: 0, contentType: 'prose', highlighted: '', sessionId: '' }],
        touchAccessed: () => 0,
        getSourceIdByLabel: () => null,
    };
    const mem = {
        list: () => [
            { id: 1, title: '铁律：QWEN 不许碰代码', category: '协作/铁律', label: 'remember:铁律' },
            { id: 2, title: '第二条久经验', category: '协作/规范', label: 'remember:第二条' },
            { id: 3, title: '第三条（应被席位挡掉）', category: '协作/杂', label: 'remember:第三条' },
        ],
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: mem, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const out = await ts.get('recall').call({ queries: ['铁律'] });
    // 席位制：最多 2 席
    const memSlots = out.result.hits.filter((h) => h.store === 'memory');
    assert.ok(memSlots.length <= 2, `长久库席位 ${memSlots.length} > 2`);
    assert.ok(memSlots.length >= 1, '久经验一条都没进来（S-5 席位制没接）');
    assert.ok(out.text.includes('铁律'), '久经验标题必须出现在回文本里');
    // 第三条必须被挡
    assert.ok(!out.text.includes('第三条（应被席位挡掉）'), '第 3 条不许进（席位 ≤2）');
});

await t('⑲ ★ queries 三形态全认且**返回数组**（数组 / JSON 串 / 单字符串）', async () => {
    const calls = [];
    const rd = {
        search: ({ query }) => { calls.push(query); return []; },
        touchAccessed: () => 0, getSourceIdByLabel: () => null,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    // 真数组 → 2 问
    await ts.get('recall').call({ queries: ['A1', 'A2'] });
    assert.deepEqual(calls, ['A1', 'A2'], `数组形态：${calls.join('|')}`);
    // JSON 数组字符串 → 2 问
    calls.length = 0;
    await ts.get('recall').call({ queries: '["B1","B2"]' });
    assert.deepEqual(calls, ['B1', 'B2'], `JSON 串形态：${calls.join('|')}`);
    // 单字符串 → 1 问（内部空格是词边界，不是多问）
    calls.length = 0;
    await ts.get('recall').call({ queries: 'C1 C2' });
    assert.deepEqual(calls, ['C1 C2'], `单串形态：${calls.join('|')}`);
    // 单数 query → 1 问
    calls.length = 0;
    await ts.get('recall').call({ query: 'D1' });
    assert.deepEqual(calls, ['D1'], `单数形态：${calls.join('|')}`);
});

// ─── ⑳-㉒ S9.40（2026-11-06 维护方决定「修 purge」）：布尔开关不许被字符串化吃掉 ───
//
// 背景（实测）：`dryRun`/`fix` 被移出工具定义后，调用方按**字符串**送来
// （`dryRun:false` → `"false"`、`days:3650` → `"3650"`）。而引擎判据是严格相等
// ⇒ `dryRun === false` 不成立 ⇒ **真删永远走干跑分支**，模型看到的还是一句"干跑"
// —— 假成功比报错更坏。这三条判据把这个坑钉死。

/** 造一份会记账的假 lifecycle/purger。 */
function makeDryRunRecorder() {
    const seen = [];
    const lc = {
        plan: (days) => ({ days, wouldDeleteSources: 0, wouldDeleteChunks: 0, oldest: null, samples: [] }),
        retention: (o) => { seen.push(o?.dryRun); return { days: o?.days, deletedSources: 1, deletedChunks: 2, deletedTrigram: 3, dryRun: false }; },
        optimize: () => ({ optimized: true }),
        checkpoint: (m) => ({ mode: m, result: [] }),
        integrityCheck: () => ({ ok: true, sqlite: 'ok', fts5: 'ok' }),
        vacuum: (o) => { seen.push(o?.dryRun); return o?.dryRun === false ? { vacuumed: true, beforeBytes: 1, afterBytes: 1 } : { dryRun: true, reclaimableBytes: 1, fileBytes: 2 }; },
        doctor: () => ({ checks: [{ name: 'x', ok: true, detail: 'y', fix: 'z' }], failed: 0, total: 1 }),
        fileBytes: () => 200,
    };
    const purger = (a) => { seen.push(a?.dryRun); return a?.dryRun === false ? { scope: a.scope, dryRun: false, deletedChunks: 3, deletedTrigram: 4, deletedSources: 5 } : { scope: a.scope, dryRun: true, wouldDelete: 2, samples: [] }; };
    return { lc, purger, seen };
}

await t('⑳ ★ dryRun 以字符串 "false" 到达 → 仍然真删（S9.40 字符串化回归）', async () => {
    const { lc, seen } = makeDryRunRecorder();
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: fakeReader, memory: fakeMemory,
        lifecycle: lc, sandbox: fakeSandbox, recall: fakeRecall,
    });
    // 字符串形态（调用方把布尔按字符串送时就是这个形态）
    const out = await ts.get('maint').call({ action: 'retention', days: 14, dryRun: 'false' });
    assert.ok(out.text.includes('已真删'), `字符串 "false" 必须真删，实际回：${out.text}`);
    assert.deepEqual(seen, [false], `引擎必须收到真布尔 false，实际收到 ${JSON.stringify(seen)}`);
    // 真布尔形态也要真删（不许被改坏）
    const out2 = await ts.get('maint').call({ action: 'retention', days: 14, dryRun: false });
    assert.ok(out2.text.includes('已真删'), `布尔 false 必须真删，实际回：${out2.text}`);
    // 不给 = 干跑（默认安全，S7 假开关教训）
    const out3 = await ts.get('maint').call({ action: 'retention', days: 14 });
    assert.ok(out3.text.includes('干跑'), `不给 dryRun 必须干跑，实际回：${out3.text}`);
    // 给 true = 干跑（不能把 true 当成"要删"）
    const out4 = await ts.get('maint').call({ action: 'retention', days: 14, dryRun: true });
    assert.ok(out4.text.includes('干跑'), `dryRun:true 必须干跑，实际回：${out4.text}`);
});

await t('㉑ ★ purge scope=source + dryRun:false（字符串形态）→ 真删，不是假干跑', async () => {
    const { purger, seen } = makeDryRunRecorder();
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: fakeReader, memory: fakeMemory,
        lifecycle: fakeLifecycle, purger, sandbox: fakeSandbox, recall: fakeRecall,
    });
    const out = await ts.get('purge').call({ scope: 'source', source: 'lbl', dryRun: 'false' });
    assert.ok(out.text.includes('已按 source 真删'), `必须真删，实际回：${out.text}`);
    assert.deepEqual(seen, [false], `引擎必须收到真布尔 false，实际收到 ${JSON.stringify(seen)}`);
    // 不给 dryRun = 干跑
    const out2 = await ts.get('purge').call({ scope: 'source', source: 'lbl' });
    assert.ok(out2.text.includes('未删任何东西'), `不给 dryRun 必须干跑，实际回：${out2.text}`);
});

await t('㉒ ★ purge scope=project → 报错拒绝（整库删须显式确认），不是假干跑', async () => {
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: fakeReader, memory: fakeMemory,
        lifecycle: fakeLifecycle, sandbox: fakeSandbox, recall: fakeRecall,
    });
    // 不带 dryRun:false 也必须报错（原来回一句干跑文案，模型看不出自己被挡了）
    let e = await catchErr(() => ts.get('purge').call({ scope: 'project' }));
    assert.equal(e?.code, 'PURGE_PROJECT_NEEDS_OWNER', `实际 ${e?.code} / ${e?.message}`);
    // 带 dryRun:false 同样报错，且第一行必须说清"整库 + 须显式确认"
    e = await catchErr(() => ts.get('purge').call({ scope: 'project', dryRun: false }));
    assert.equal(e?.code, 'PURGE_PROJECT_NEEDS_OWNER', `实际 ${e?.code}`);
    const first = String(e?.message ?? '').split('\n')[0];
    assert.ok(first.includes('蒸发') || first.includes('整库'), `第一行必须写明整库风险，实际：${first}`);
    assert.ok(first.includes('维护方'), `第一行必须写明须显式确认，实际：${first}`);
    // 不许出现"加 dryRun:false 就能删"这种错指路
    assert.ok(!first.includes('dryRun:false'), `第一行不许指路加 dryRun:false（对 project 是错的），实际：${first}`);
});

await t('㉓ ★ recall{full:true} 真取全文（2026-11-12 设计确定：案：run 入库必须能整份取回）', async () => {
    // 夹具：一个 3 块、每块 4000 B 的源 —— 窗口化下每块只会回 800 B（共 2.4KB，
    // 正是真机实测 12KB 源只回两成的那个形状）。full:true 必须整源拼回。
    const chunkText = (i) => `${`第${i}块正文行。`.repeat(400)}`;
    const chunks = [1, 2, 3].map((i) => ({ title: `块${i}`, content: chunkText(i), source: 'full-src', contentType: 'prose' }));
    const totalBytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.content, 'utf8'), 0);
    assert.ok(totalBytes > 8000, `夹具要够大，实际 ${totalBytes} B`);

    const rd = {
        search: () => chunks.map((c) => ({ ...c, rank: 0, highlighted: '', sessionId: '' })),
        getSourceIdByLabel: (label) => (label === 'full-src' ? 7 : null),
        getChunksBySource: (id) => (id === 7 ? chunks : []),
        touchAccessed: () => 0,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });

    // A. 默认（不给 full）→ 仍是窗口，明显小于原文
    const slim = await ts.get('recall').call({ queries: ['正文行'], source: 'full-src' });
    const slimBytes = Buffer.byteLength(slim.text, 'utf8');
    assert.ok(slimBytes < 4000, `默认路径必须仍窗口化，实际 ${slimBytes} B`);

    // B. full:true + 精确 source → 整源拼回，字节数接近原文（不是窗口）
    const full = await ts.get('recall').call({ queries: ['正文行'], source: 'full-src', full: true });
    const fullBytes = Buffer.byteLength(full.text, 'utf8');
    assert.equal(full.result.full, true, 'result.full 必须为 true');
    assert.equal(full.result.skippedChunks, 0, `不该有跳过的块，实际 ${full.result.skippedChunks}`);
    assert.ok(fullBytes >= totalBytes, `full:true 必须拿回全部正文：原文 ${totalBytes} B，实回 ${fullBytes} B`);
    assert.ok(fullBytes > slimBytes * 2, `full 必须显著大于窗口：${fullBytes} vs ${slimBytes}`);
    // 三块的标题都要在（证明块没丢）
    for (const i of [1, 2, 3]) assert.ok(full.text.includes(`块${i}`), `缺块${i}`);

    // C. full 认字符串 "true"（参数字符串化，S9.40 同型）
    const strFull = await ts.get('recall').call({ queries: ['正文行'], source: 'full-src', full: 'true' });
    assert.equal(strFull.result.full, true, 'full="true" 也要认');

    // D. 无精确 label 时退回 search 命中块、整块不切
    const rd2 = { ...rd, getSourceIdByLabel: () => null };
    const ts2 = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd2, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const loose = await ts2.get('recall').call({ queries: ['正文行'], full: true });
    assert.ok(Buffer.byteLength(loose.text, 'utf8') >= totalBytes, '无 source 时也要整块回，不切窗口');
});

await t('㉔ ★ 片段有**可见边界**（默认路径必须标出"这是片段"；整块给完时不标）', async () => {
    const bigText = `${'填充。'.repeat(3000)}命中词${'尾部。'.repeat(3000)}`;
    const smallText = '短块，一次给完，不需要标注。';
    const rd = {
        search: ({ query }) => (query === '小' ? [{
            title: '短块', content: smallText, source: 's', rank: 0, contentType: 'prose', highlighted: '', sessionId: '',
        }] : [{
            title: '长块', content: bigText, source: 's', rank: 0, contentType: 'prose', highlighted: '', sessionId: '',
        }]),
        touchAccessed: () => 0,
        getSourceIdByLabel: () => null,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });

    // A. 长块被切 → 必须出现标注，且点明 full:true
    const out = await ts.get('recall').call({ queries: ['命中词'] });
    assert.ok(out.text.includes('片段'), `长正文被切必须标注，实际回：${out.text.slice(0, 200)}`);
    assert.ok(out.text.includes('full:true'), '标注必须告诉模型怎么拿全文');
    // 标注要带真实数字（不是写死的模板）
    assert.ok(/〔片段：\d+\/\d+ B/.test(out.text), `标注必须带实测字节，实际：${out.text.match(/〔[^〕]*〕/)?.[0]}`);

    // B. 短块整块给完 → 不许出现标注（假报警同样有害）
    const small = await ts.get('recall').call({ queries: ['小'] });
    assert.ok(!small.text.includes('片段：'), `整块给完不该标注，实际：${small.text}`);
});

await t('㉕ ★ full:true 的 40KB 闸：回文不得超 40,000（外层 containment 同口径），超了要指路去读文件', async () => {
    // 病根（2026-11-12 真机实测）：本常量原是 65,536，而平台层
    // ours/output-containment.js 的 DEFAULT_MAX_RESULT_BYTES = 40_000 会把**整个返回**
    // 砍成头 6000 + 尾 2000。64,786 B 的源 full:true → 回文 65,324 B：
    // **中间 57,314 字符被砍**，且 full:true 对此一无所知。设计确定：案：内层压到 40KB。
    const OUTER_CAP = 40_000;           // = ours/output-containment.js DEFAULT_MAX_RESULT_BYTES
    const bigChunk = (i) => `${'x'.repeat(3900)}\n第${i}块\n`;
    // 20 块 × ~3.9KB ≈ 78KB：必然超 40KB，必然要跳块
    const chunks = Array.from({ length: 20 }, (_, i) => ({
        title: `块${i + 1}`, content: bigChunk(i + 1), source: 'huge-src', contentType: 'prose',
    }));
    const totalBytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.content, 'utf8'), 0);
    assert.ok(totalBytes > 70_000, `夹具要够大（应 >70KB），实际 ${totalBytes} B`);

    const rd = {
        search: () => chunks.map((c) => ({ ...c, rank: 0, highlighted: '', sessionId: '' })),
        getSourceIdByLabel: (l) => (l === 'huge-src' ? 9 : null),
        getChunksBySource: (id) => (id === 9 ? chunks : []),
        touchAccessed: () => 0,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });

    const out = await ts.get('recall').call({ queries: ['x'], source: 'huge-src', full: true });
    const outBytes = Buffer.byteLength(out.text, 'utf8');

    // ① 硬判据：回文必须 ≤ 40,000，否则外层 containment 会再砍一刀（说得出做不到）
    assert.ok(outBytes <= OUTER_CAP,
        `full:true 回文 ${outBytes} B > 外层 ${OUTER_CAP} B —— 会被 output-containment 砍成头尾，`
        + `full:true 就成了"说得出做不到"。必须在本层就压住。`);

    // ② 必须真的跳块并如实报数（不是静默丢）
    assert.ok(out.result.skippedChunks > 0, `78KB 的源必然跳块，实际 skippedChunks=${out.result.skippedChunks}`);
    assert.ok(out.result.hits.length > 0, '至少要放下第一块（不许一块都不给）');
    assert.equal(out.result.hits.length + out.result.skippedChunks, chunks.length,
        `放下 ${out.result.hits.length} + 跳过 ${out.result.skippedChunks} 应 == 总块数 ${chunks.length}`);

    // ③ 超限时**必须指路去读文件**（维护方 2026-11-12：「再多内容就应该去读文件了」）
    assert.ok(/读文件|read|op:"run"/.test(out.text),
        `超 40KB 必须明确指路"去读文件"，实际尾提示：${out.text.slice(-220)}`);

    // ④ 文案里的 KB 标签必须是 40KB 而不是 39KB（40,000/1024*ceil = 40）
    assert.ok(out.text.includes('40KB'), `预算标签该是 40KB（十进制口径），实际：${out.text.match(/一次最多 \S+/)?.[0]}`);

    // ⑤ 不超限时**不许**出现"跳块/读文件"提示（假报警同样有害）
    const rd2 = {
        search: () => [],
        getSourceIdByLabel: () => 12,
        getChunksBySource: () => [
            { title: '小块', content: '小块正文，一次给完。', source: 'small-src', contentType: 'prose' },
        ],
        touchAccessed: () => 0,
    };
    const ts2 = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd2, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const small = await ts2.get('recall').call({ queries: ['小块'], source: 'small-src', full: true });
    assert.equal(small.result.skippedChunks, 0, '小块不该跳');
    assert.ok(!small.text.includes('没显示'), `小块不该出现"没显示"提示，实际：${small.text}`);
});

await t('㉖ ★ full:true 去边界重叠（2026-11-12 第三次定案）：剥重叠、但不许误删正文里合法的重复行', async () => {
    // 病根：chunkPlainText 的 overlap=2 让相邻块共享 2 行，整源拼回时变成重复。
    // 实测 run 的 200 行输出拼回 222 行。修法=只剥"上一块尾部 == 当前块头部"的连续行。
    //
    // ★ 这条用例的核心判据是**不误伤**：
    //   日志里"同一行出现多次"是常态（比如同一条命令结果打印两遍），
    //   全局去重会把真内容删掉。只有"跨块边界"的重复才是 overlap。
    const A = 'blockA-line1\nblockA-line2\nSHARED-1\nSHARED-2';
    const B = 'SHARED-1\nSHARED-2\nblockB-line1\nblockB-line2';
    // C 里故意放两行一模一样的正文（不是 overlap，是内容本身重复）
    const C = 'DUP-CONTENT\nDUP-CONTENT\nblockC-tail';
    const chunks = [
        { title: '块A', content: A, source: 'ov-src', contentType: 'prose' },
        { title: '块B', content: B, source: 'ov-src', contentType: 'prose' },
        { title: '块C', content: C, source: 'ov-src', contentType: 'prose' },
    ];
    const rd = {
        search: () => [],
        getSourceIdByLabel: (l) => (l === 'ov-src' ? 5 : null),
        getChunksBySource: (id) => (id === 5 ? chunks : []),
        touchAccessed: () => 0,
    };
    const ts = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });

    const out = await ts.get('recall').call({ queries: ['x'], source: 'ov-src', full: true });

    // ① A/B 边界那 2 行重叠必须只出现一次
    const sharedCount = (out.text.match(/^SHARED-1$/gm) ?? []).length;
    assert.equal(sharedCount, 1, `SHARED-1 是 A 尾/B 头重叠，必须只出现 1 次，实际 ${sharedCount} 次`);
    const shared2 = (out.text.match(/^SHARED-2$/gm) ?? []).length;
    assert.equal(shared2, 1, `SHARED-2 同上，实际 ${shared2} 次`);
    assert.equal(out.result.strippedOverlapLines, 2, `应剥 2 行，实际 ${out.result.strippedOverlapLines}`);

    // ② A/B 各自独有的行必须都在（去重不许吃掉真内容）
    for (const ln of ['blockA-line1', 'blockA-line2', 'blockB-line1', 'blockB-line2']) {
        assert.ok(out.text.includes(ln), `去重误删了正文行：${ln}`);
    }

    // ③ ★ 最关键：C 块内部那两行一模一样的 DUP-CONTENT **必须两行都还在**
    //    （它是"内容重复"不是"边界重叠"，全局去重会误删）
    const dupCount = (out.text.match(/^DUP-CONTENT$/gm) ?? []).length;
    assert.equal(dupCount, 2, `C 块内部合法的重复行必须保留 2 行（不许全局去重误删），实际 ${dupCount} 行`);

    // ④ 标题要有"已去重叠 N 行"的如实交代
    assert.ok(/已去重叠\s*2\s*行/.test(out.text), `标题须如实报去重行数，实际首行：${out.text.split('\n')[0]}`);

    // ⑤ 无重叠的源（markdown 路径，如 index{path}）不许瞎剥
    const plainChunks = [
        { title: 'p1', content: 'aaa\nbbb\nccc', source: 'no-ov', contentType: 'prose' },
        { title: 'p2', content: 'ddd\neee\nfff', source: 'no-ov', contentType: 'prose' },
    ];
    const rd2 = {
        search: () => [],
        getSourceIdByLabel: () => 6,
        getChunksBySource: () => plainChunks,
        touchAccessed: () => 0,
    };
    const ts2 = createTools({
        registry: createRegistry({ level: 'error' }),
        writer: fakeWriter, reader: rd2, memory: fakeMemory, lifecycle: fakeLifecycle,
        sandbox: fakeSandbox, recall: fakeRecall,
    });
    const noOv = await ts2.get('recall').call({ queries: ['x'], source: 'no-ov', full: true });
    assert.equal(noOv.result.strippedOverlapLines, 0, `无重叠的源不许剥任何行，实际剥了 ${noOv.result.strippedOverlapLines}`);
    assert.ok(!noOv.text.includes('已去重叠'), '无重叠时标题不许出现"已去重叠"');
    for (const ln of ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']) {
        assert.ok(noOv.text.includes(ln), `无重叠源被误删：${ln}`);
    }
});

console.log(`\n14-tools: ${n} 项全绿`);
