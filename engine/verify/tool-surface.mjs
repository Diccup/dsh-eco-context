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
 * verify/tool-surface.mjs — **G11 工具面一致性门**
 *
 * 为什么这道门必须存在
 * ─────────────────────────────────────────────────────────
 * 1.0.0 把 11 个工具折叠成一个工具位。**2026-11-04 设计确定：名：`ctx`**
 * （`ctx_run` 改名 `ctx`；`ctx_recall` 并入 `op: 'recall'`，不留旧名兜底）。
 * 折叠是在引擎里做的 —— 所以凡是按老工具名调引擎的代码，全部会静默失效：
 *
 *     engine.call('ctx_index')  → 没有这个工具位
 *     engine.call('ctx_run')    → 同上（旧名已随 toOpCall 兜底一起删除）
 *
 * 而这批代码几乎都写了 `catch { }`（"失败就别挡主流程"），于是错误被吞掉，
 * 功能**看起来在、实际什么都不做**。2026-11-03 真机实测抓到过三处。
 *
 * ★ 2026-11-04 的立场变化：以前这道门断言"旧名字必须还能兜住"（靠 toOpCall）。
 *   设计确定：「不需要做兜底，直接改安装包」之后，**这条判据整个反过来了**：
 *   旧名字必须调不通。兜底 = 桥上留着已经没有的东西。
 *
 * 本门做什么（全部走真实解析路径，不注入 seams）
 * ─────────────────────────────────────────────────────────
 *   ① 引擎注册出来的工具名恰好是 {ctx}，多一个都不行
 *   ② 旧名字（ctx_run / ctx_recall / ctx_index / ctx_search）必须**全部调不通**
 *   ③ 14 个 op 每一个都能被真分派（含并进来的 recall 与新增的 switch）
 *   ④ 真装配下 op:search 可用（web 已注入，不是 NO_INPUT）
 *   ④b engine-client 自己装配时也注入 web
 *   ⑤ op:index 写进去 → op:recall 能搜回来（单工具位上的真往返）
 *   ⑥ 全包代码行里不许再出现"按老工具名调用"的形状（包括 ctx_run/ctx_recall）
 *   ⑦ 模式系统退役：modes/、layout 的 modesDir、Config 的 mode 键、vanilla 字样都不许存在
 *   ⑧ skills/*.md 不许再教旧工具名（文档面；只许出现在 no-longer-exists 语境）
 *   ⑨ 描述真源 = engine/blocks/14-tools/descriptions/ctx.md（2026-11-04 文案面整合；
 *      改一个字立刻跟着变、删掉就抛 = 没被旁路回 JS）
 *
 * 跑法：node engine/verify/tool-surface.mjs [--dir <包根>]
 *      默认验 `releases/1.0.0`（成品），可用 --dir 指向装机位。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 本文件有两个家：开发区 `engine/verify/` 和成品里 `engine/verify/`。
//   两种都是 `<根>/engine/verify/` —— 所以默认包根就是再上两级。
const PKG_ROOT = path.dirname(path.dirname(HERE));

const argDir = (() => {
    const i = process.argv.indexOf('--dir');
    if (i > -1) return path.resolve(process.argv[i + 1]);
    if (fs.existsSync(path.join(PKG_ROOT, 'releases', '1.0.0')))
        return path.join(PKG_ROOT, 'releases', '1.0.0');
    return PKG_ROOT;
})();

// ★ 临时目录一律走 libs/tempdir.js：不预设盘符，建了就自动删。
const TMP = makeTempRunDir('g11');
/** 所有开了 DB 的引擎/客户端，退出前必须逐个关 —— 句柄不开着才删得掉目录 */
const holders = [];

/**
 * 1.0.0 唯一合法的 op 清单（与 OP_CATALOG 对齐，2026-11-04；switch 于 2026-11-05 新增）。
 * ★ 2026-11-09 ④步 CTX 净身：摘掉 `search`（14 → 13）。op:search 整条随 FP 迁出，
 *   CTX 按定义不含 SEARCH（维护方 13:5x「CTX不包含SEARCH」）。见净身版 §三-3/§三-1。
 */
const WANT_OPS = ['run', 'recall', 'index', 'remember', 'pin', 'unpin', 'memory', 'stats', 'doctor', 'maint', 'purge', 'switch', 'list'];
/** 该死透的旧工具名：工具面折叠的历史产物，现在调不通才是对的。 */
const DEAD_NAMES = ['ctx_run', 'ctx_recall', 'ctx_index', 'ctx_search', 'ctx_execute', 'ctx_batch_execute', 'ctx_fetch_and_index'];

let passed = 0;
const failures = [];
const ok = (label) => { passed++; console.log(`  ✓ ${label}`); };
const fail = (label, detail) => { failures.push(`${label}: ${detail}`); console.log(`  ✗ ${label} — ${detail}`); };
async function check(label, fn) {
    try { await fn(); ok(label); }
    catch (error) { fail(label, error instanceof Error ? error.message : String(error)); }
}

console.log(`工具面一致性验收：${argDir}\n`);

try {
    if (!fs.existsSync(path.join(argDir, 'engine', 'index.mjs')))
        throw new Error(`不是有效成品目录：${argDir}`);
    fs.mkdirSync(TMP, { recursive: true });

    // ────────── ①②③ 引擎真实工具面 ──────────
    const engineUrl = pathToFileURL(path.join(argDir, 'engine', 'index.mjs')).href;
    const { createEngine } = await import(engineUrl);

    // ★ 2026-11-09 ④步 CTX 净身（净身版 §三-9）：**web 导入探测段整段退役**。
    //   原文（已在 BACKUP\tool-surface.mjs 留底）：
    //     const webCandidates = [ <argDir>/ours/web-search.js, <argDir>/engine/ours/web-search.js ];
    //     const webPath = webCandidates.find(existsSync);
    //     if (!webPath) throw new Error('找不到 web-search.js … —— 包根判定不对？');
    //     const web = await import(webPath);
    //     const engine = await createEngine({ contentDir: TMP, web });
    //   为什么必须退役而不能留：① web-search.js 随 search 迁 FP，CTX 成品里**不再有这件**，
    //   `if (!webPath) throw` 会让整个 G11 在第一步就死（不是判据红，是门自己崩）；
    //   ② CTX 侧已无任何消费 `deps.web` 的 op（op:search 与 index{url} 双入口全迁走，见 §三-1/2），
    //   继续往引擎注 web 就是给一辆没有轮子的车装油箱。
    //   判据完整性不受损：本条原本是"用 web 装配能跑"，而 ③ 会用真实 registry 逐 op 真分派，
    //   `deps.web` 缺失在 CTX 侧已无路径可达（引擎不读它）。
    const engine = await createEngine({ contentDir: TMP });
    holders.push(engine);

    await check('① 引擎注册出的工具名恰好是 {ctx}', () => {
        const names = [...(engine.toolNames ?? [])].sort();
        if (names.length !== 1 || names[0] !== 'ctx') {
            throw new Error(`实际 ${JSON.stringify(names)}，期望 ["ctx"]`
                + (names.includes('ctx_run') || names.includes('ctx_recall')
                    ? '（旧工具名还在注册面上 —— 2026-11-04 的折叠改名没生效？）' : ''));
        }
    });

    await check('② 旧工具名必须全部调不通（不留兜底 = 判据反向）', async () => {
        // 2026-11-04 设计确定：「不需要兜底」：旧名字经引擎 call 必须报"没有这个工具/这个 op"。
        //   引擎 call() 的 op 路会认 `index`/`search` 这类**裸 op 名**，
        //   但 `ctx_index` 这种带前缀的旧名只可能走工具名路 —— 必须失败。
        const alive = [];
        for (const name of DEAD_NAMES) {
            const r = await engine.call(name, { op: 'list' });
            const errText = String(r?.error?.message ?? r?.content?.[0]?.text ?? '');
            const refused = r?.ok === false || r?.isError === true || r?.content === undefined;
            if (!refused) alive.push(`${name} → ok=${JSON.stringify(r?.ok)}`);
            // 报错文案必须可读（不许裸奔 ReferenceError 那种）
            else if (r && !/no (op|such)|没有 (op|工具)/i.test(errText) && errText)
                alive.push(`${name} 报错不可读：${errText.slice(0, 80)}`);
        }
        if (alive.length > 0)
            throw new Error(`这些旧名字竟然还能调通（兜底没删干净）：${alive.join(' | ')}`);
        // 正面确认：同一个能力用**新**写法必须成功，否则上面"全失败"没意义
        const good = await engine.call('ctx', { op: 'index', content: 'probe-good', source: 'probe' });
        if (good?.isError === true)
            throw new Error(`正确调用 ctx({op:'index'}) 反而失败：${String(good?.content?.[0]?.text).slice(0, 120)}`);
    });

    // ────────── ③ 每一个 op 都必须真的能分派 ──────────
    //
    // ★★ 2026-11-04：这一条因为一次误判才写，但误判暴露了真盲区：
    //   当时 `ctx({op:'stats'})` 在真机上一律返回 UNKNOWN_OP，实现方误判为
    //   "两张 op 表接错"。**实测证明是错的**：真因是**装配失败**
    //   （contentDir 不可写 → assembled=null → toolsFactory 从未被调 →
    //   registry 0 个 op），而 opCatalog 是静态清单、registry 是运行时表。
    //   所以这里先守"装配成功"这个前提，再逐 op 真调 —— 判据要能区分故障类型。
    // ★ 2026-11-09 ④步 CTX 净身：标题 14 → 13（净身版 §三-10b）。
    await check('③ ctx 的 13 个 op 都能被真分派（含 recall 与 switch，不是只有 list 能用）', async () => {
        if (!engine.assembled) {
            const why = engine.assembleError?.message ?? String(engine.assembleError ?? '未知');
            throw new Error(`引擎装配失败，registry 里 0 个 op —— 每个 op 都会 UNKNOWN_OP。`
                + `这不是"op 表接错"，是装配坏了：${why}`);
        }
        if (engine.registry.toolList().length === 0)
            throw new Error('装配成功但 registry 里 0 个 op —— 14-tools 的 reg() 没跑，检查 toolsFactory');
        // ★ 跳过表头行与首句：`op  required  what` 里的 `op` 是列名，
        //   而描述第一行 `ctx — 一个壳…` 里的 `ctx` 是壳的名字，都不是 op。
        const table = await engine.call('ctx', {});
        const raw = String(table?.content?.[0]?.text ?? '');
        const declared = [...raw.matchAll(/^([a-z]+)\s+(\S|—)/gm)].map((m) => m[1])
            .filter((n) => n !== 'op' && n !== 'ctx');
        if (declared.length !== WANT_OPS.length)
            throw new Error(`ctx 自描述解析出 ${declared.length} 个 op（应 ${WANT_OPS.length}）：${declared.join(',')}`);
        for (const want of WANT_OPS) {
            if (!declared.includes(want))
                throw new Error(`op 表里没有 ${want}（2026-11-04 定案的清单少了它）`);
        }
        // 每个 op 给一份**最小合法参数**，能分派就算过（业务失败不算门红）
        // ★ 2026-11-09 净身：`search` 行摘除（op 已不在清单里，留着就是给不存在的 op 备参数）。
        const args = {
            run: { op: 'run', language: 'javascript', code: 'return 1+1;' },
            recall: { op: 'recall', queries: ['probe'] },
            index: { op: 'index', content: 'probe content', source: 'g11-probe' },
            remember: { op: 'remember', title: 'g11', content: 'g11', category: 'g11' },
            pin: { op: 'pin', label: 'g11-probe', category: 'g11' },
            unpin: { op: 'unpin', label: 'g11' },
            memory: { op: 'memory', action: 'list' },
            stats: { op: 'stats' },
            doctor: { op: 'doctor' },
            maint: { op: 'maint', action: 'plan' },
            purge: { op: 'purge', scope: 'session', dryRun: false },
            switch: { op: 'switch', action: 'list' },
            list: { op: 'list' },
        };
        const dead = [];
        for (const op of declared) {
            const r = await engine.call('ctx', args[op] ?? { op });
            const t = String(r?.content?.[0]?.text ?? '');
            // 判据：不许是 UNKNOWN_OP（那是"根本没分派出去"）
            if (/UNKNOWN_OP|没有 op=/.test(t)) dead.push(`${op} → ${t.slice(0, 80)}`);
        }
        if (dead.length > 0)
            throw new Error(`${dead.length}/${declared.length} 个 op 分派不出去：\n    ${dead.join('\n    ')}`);
    });

    // ────────── ④ / ④b 【2026-11-09 退役】──────────
    //
    // ★ 净身版 §三-10b：这两条**直接真调 `op:search`**，摘 op 后必失败 ⇒ 同批退役。
    //   ④  真装配下 op:search 可用（web 已注入）
    //   ④b engine-client 自己装配时也注入 web（含源码里 `web,` 注入模式的反射检查）
    //   退役不采改判的理由（与 §三-10 ⑫ 同一判别式）：**改判 = 让门去查 CTX 已不存在的件**。
    //   连带：`engine-client.js` 的 `loadWebModule()` 与 web 注入链本轮一并摘除（§三-15），
    //   若不退役 ④b，它会一边报"没注入 web"一边要求一件已被删掉的东西。
    //   覆盖转移账：CTX 侧"op:search 真可用 + 客户端自注入 web"两条回归**归零随迁 FP**，
    //   FP 须自建等价门（a77 K4 同型账，见 §三-10）。

    // ────────── ⑤ 单工具位上的真往返：op:index 写 → op:recall 搜回 ──────────
    //
    // 2026-11-03 这条验的是"旧名字经 toOpCall 兜底后真能写进去"；
    // 兜底删除后**这条更简单也更严**：所有调用都直接写 ctx + op，
    // 所以往返必须在一个工具位上真跑通（写进去了 ≠ 搜得回来）。
    await check('⑤ ctx(op:index) 写进去 → ctx(op:recall) 能搜回来（真往返）', async () => {
        const { EngineClient } = await import(pathToFileURL(path.join(argDir, 'platform', 'engine-client.js')).href);
        const dir = path.join(TMP, 'roundtrip');
        const c = new EngineClient({ engineRoot: path.join(argDir, 'engine'), ctx: {}, contentDir: dir });
        holders.push(c);
        c.start();
        await c.initialize();
        try {
            const marker = 'zebrafish' + Math.random().toString(36).slice(2, 8);
            const w = await c.callTool('ctx', { op: 'index', content: `${marker} alpha beta`, source: 'roundtrip-probe' });
            if (w?.isError === true) throw new Error(`op:index 写入失败：${String(w?.content?.[0]?.text).slice(0, 140)}`);
            const r = await c.callTool('ctx', { op: 'recall', queries: [marker], source: 'roundtrip-probe' });
            const t = String(r?.content?.[0]?.text ?? '');
            if (!t.includes(marker))
                throw new Error(`写进去了但 op:recall 搜不回来 —— 召回链路是假的（回：${t.slice(0, 140)}）`);
        }
        finally { c.retire(); }
    });

    // ────────── ⑥ 静态：代码行里不许把老名字当工具名 ──────────
    await check('⑥ 全包代码行里没有把旧工具名当工具调用（注释可以，代码不行）', () => {
        // "当工具名"的调用形状：callTool('ctx_index' / callEngine('ctx_run' /
        // engine.call('ctx_search' …（ctx_run / ctx_recall 于 2026-11-04 也入此列）
        const CALL_SHAPE = /\.(?:callTool|callEngine|call)\s*\(\s*['"`](ctx_run|ctx_recall|ctx_index|ctx_search|ctx_execute|ctx_batch_execute|ctx_fetch_and_index|ctx_stats|ctx_doctor|ctx_memory|ctx_pin|ctx_unpin|ctx_purge|ctx_maint|ctx_list|ctx_fetch|ctx_insight|ctx_upgrade)['"`]/;
        const offenders = [];
        const isComment = (line) => /^\s*(?:[*/]|#)/.test(line) || line.includes(' * ');
        const scan = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === 'deps' || e.name === 'fp' || e.name === 'vendor' || e.name === 'ref') continue;
                    scan(p);
                    continue;
                }
                if (!/\.(?:js|mjs)$/.test(e.name)) continue;
                // 门自己在断言这些名字，不能被自己抓到
                if (path.basename(p) === 'tool-surface.mjs') continue;
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    if (isComment(line)) return;
                    if (CALL_SHAPE.test(line)) offenders.push(`${path.relative(argDir, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
                });
            }
        };
        scan(argDir);
        if (offenders.length > 0)
            throw new Error(`发现 ${offenders.length} 处按旧工具名调用（1.0.0 只有 ctx + op）：\n    ${offenders.slice(0, 6).join('\n    ')}`);
    });

    // ────────── ⑦ 模式系统已退役（原版转接整条删除的负断言） ──────────
    //
    // 2026-11-04 设计确定：vanilla 不做了，将来要原版体验就另写独立桥。
    // 判据不是"清单内容对"，而是**这套东西整体不许再存在**：
    //   modes/ 目录、layout 的 modesDir、Config 的 mode 键、'vanilla' 字样。
    // 留任何一处，将来就会有人"顺手"把它当还活着的接口用。
    await check('⑦ 模式系统退役：modes/ 与 mode 键与 vanilla 字样都不许存在', () => {
        const modesDir = path.join(argDir, 'modes');
        if (fs.existsSync(modesDir))
            throw new Error(`modes/ 还存在着：${modesDir}（模式已退役，将来原版转接是独立桥，不在本包）`);
        const layoutSrc = fs.readFileSync(path.join(argDir, 'platform', 'layout.js'), 'utf8');
        if (layoutSrc.includes('modesDir'))
            throw new Error('layout.js 还导出 modesDir（探测一个不存在的目录 = 指向不存在的东西）');
        const pluginSrc = fs.readFileSync(path.join(argDir, 'platform', 'plugin.js'), 'utf8');
        if (/z\.union\(\[[^\]]*vanilla/.test(pluginSrc))
            throw new Error('plugin.js 的 Config 还接受 mode: vanilla');
        // 禁的是**字符串字面量**（活接口的形状）；注释里"vanilla 已删除"的历史说明允许。
        for (const f of ['deployment.js', 'runtime.js', 'routing.js', 'tool-def.js', 'catalog.js', 'skill-set.js', 'plugin.js']) {
            const src = fs.readFileSync(path.join(argDir, 'platform', f), 'utf8');
            if (/['"](vanilla|bubble)['"]/.test(src))
                throw new Error(`platform/${f} 还留着 'vanilla'/'bubble' 字符串字面量（模式系统已退役）`);
        }
        const catalogSrc = fs.readFileSync(path.join(argDir, 'platform', 'catalog.js'), 'utf8');
        if (!catalogSrc.includes(`'ctx'`))
            throw new Error('catalog.js 的 FULL_CATALOG 里看不到 ctx');
        if (catalogSrc.includes(`'ctx_run'`) || catalogSrc.includes(`'ctx_recall'`))
            throw new Error('catalog.js 里还写着旧工具名（注册面早就没有了）');
    });
    // ────────── ⑧ 技能文档面：不许再教模型调旧工具名 ──────────
    //
    // SKILL.md 是**给模型看的路由文档**，G11⑥ 只扫 .js/.mjs 够不着它。
    // 真事故（2026-11-04）：1.0.0 折叠成 ctx 之后，skills/ 拷的还是 11 工具时代
    // 的原文（"Call the ctx_doctor MCP tool directly"），模型照文档路由就调到
    // 不存在的工具上 —— 门全绿，模型面全错。
    // 判据：旧名**可以**出现在禁止/说明语境（挨着 no longer / not exist /
    // became 的行），不许出现在"教你这么调"的语境。
    await check('⑧ skills/*.md 不再教旧工具名（只许出现在 no-longer-exists 语境）', () => {
        const skillsDir = path.join(argDir, 'skills');
        if (!fs.existsSync(skillsDir)) throw new Error(`没有 skills/：${skillsDir}`);
        const OLD = /ctx_(execute|execute_file|batch_execute|fetch_and_index|index|search|stats|doctor|purge|upgrade|insight|run|recall|remember|pin|unpin|memory|maint)\b/g;
        const NEGATIVE = /no longer|not exist|no such|became|not mounted|stop[:：]|if you catch|only the `?ctx`? tool/i;
        const offenders = [];
        for (const d of fs.readdirSync(skillsDir)) {
            const f = path.join(skillsDir, d, 'SKILL.md');
            if (!fs.existsSync(f)) continue;
            const text = fs.readFileSync(f, 'utf8');
            // 语境是**跨行句子**（"there is only the ctx tool; `ctx_index` / as a
            // tool name no longer exists" 分成两行）—— 逐行判会把禁止句误报成教学句。
            // 所以看每个旧名**前后 240 字符窗口**里有没有否定语。
            let m;
            while ((m = OLD.exec(text)) !== null) {
                const win = text.slice(Math.max(0, m.index - 240), m.index + 240);
                if (NEGATIVE.test(win)) continue;
                const line = text.slice(0, m.index).split('\n').length;
                offenders.push(`${d}/SKILL.md:${line} 教旧名 ${m[0]}：${text.slice(m.index - 40, m.index + 60).replace(/\s+/g, ' ').trim()}`);
            }
        }
        if (offenders.length > 0)
            throw new Error(`${offenders.length} 处技能文档还在按旧工具名教模型：\n    ${offenders.slice(0, 6).join('\n    ')}`);
    });

    // ────────── ⑧b 技能命名面：必须是 `ctx` 或 `ctx-op-*` ──────────
    //
    // ★ 2026-11-05 设计确定：能力就是 `ctx({op:"…"})`，技能名不许再挂旧工具名。
    //   旧清单叫 context-mode / ctx-doctor / ctx-index / ctx-search / ctx-stats，
    //   那是 11 工具时代的命名 —— 模型看见 `ctx-search` 会把技能名当工具名，
    //   文档面与工具面又变成两套口径（G11⑧ 守不住这一层：它只查正文里的
    //   旧名，不查"目录名本身就是旧名"）。
    //   判据：每个技能目录名必须命中 `ctx` 或 `ctx-op-<op>`，且 `<op>` 在
    //   OP_CATALOG 里真实存在 —— 名字指不到 op 就是陷阱，不是挂载。
    await check('⑧b 技能名必须是 ctx 或 ctx-op-<真实 op>', async () => {
        const skillsDir = path.join(argDir, 'skills');
        if (!fs.existsSync(skillsDir)) throw new Error(`没有 skills/：${skillsDir}`);
        const { OP_CATALOG } = await import(pathToFileURL(path.join(argDir, 'engine', 'index.mjs')).href + '?ts=' + Date.now());
        const ops = new Set(OP_CATALOG.map((o) => o.op));
        const bad = [];
        const dirs = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
        if (!dirs.includes('ctx'))
            bad.push('缺 `ctx` 总纲技能（新命名的锚点）');
        for (const d of dirs) {
            if (d === 'ctx') continue;
            const m = /^ctx-op-([a-z]+)$/.exec(d);
            if (!m) { bad.push(`${d}：名字不是 ctx 或 ctx-op-*`); continue; }
            if (!ops.has(m[1])) bad.push(`${d}：op "${m[1]}" 不在 OP_CATALOG 里`);
            // frontmatter 的 name 必须与目录名一致（DSH 按 frontmatter 的 name 注册）
            const head = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8').slice(0, 400);
            const fn = /^name:\s*(\S+)\s*$/m.exec(head);
            if (!fn || fn[1] !== d) bad.push(`${d}：frontmatter name=${fn ? fn[1] : '(缺)'} 与目录名不一致`);
        }
        if (bad.length > 0)
            throw new Error(`技能命名不合口径：\n    ${bad.join('\n    ')}`);
    });

    // ────────── ⑨ 描述真源必须是 descriptions/ctx.md（防"文案被旁路回 JS"） ──────────
    //
    // ★ 2026-11-04 文案面整合的收口判据（设计确定：，仿 2.0 src/prompt/tools/<tool>.md）：
    //   改文案只改 .md，不碰源码。这条守的是**反向漂移**：
    //   有人（或某次合并）把描述换回 JS 拼的静态表 —— .md 还在、门③照样解析出 13 行，
    //   但模型看到的不再是 .md。光对拍字符串不够（常量本来就从 .md 读的，是恒等式），
    //   所以这一项**做真实行为断言**（判据是"过程"，不是"相等"）：
    //     ① 把 ctx.md 改一个字 → 重新装配的引擎必须立刻报出这个新字
    //        （证明描述真源是那个文件，不是任何 JS 常量）；
    //     ② 删掉 ctx.md → 引擎的文案加载器必须当场抛（不许静默退回内置文案）；
    //     ③ 首行必须是 Example（2.0 倒序形态：Example→必填→是什么→op 表）。
    await check('⑨ 改 ctx.md 一个字，引擎描述立刻跟着变；删掉它就抛', async () => {
        const { loadDescription, CTX_RUN_DESCRIPTION } = await import(pathToFileURL(path.join(argDir, 'engine', 'blocks', '14-tools', 'index.js')).href + '?ts=' + Date.now());
        const mdPath = path.join(argDir, 'engine', 'blocks', '14-tools', 'descriptions', 'ctx.md');
        if (!fs.existsSync(mdPath))
            throw new Error(`成品缺文案真源 ${mdPath}（14-tools import 就该抛，走到这里说明加载器被改了）`);
        const orig = fs.readFileSync(mdPath, 'utf8');
        // ★★ 2026-11-08 修门（G11⑨ 回归"门只观察，不改成品"）：
        //   S9.44 的写入回环是直接改**盘上 ctx.md**（写哨兵→写空→finally 还原），留下两个残病：
        //     ① mtime 被刷 → 装前对拍 / 装配后改动账出现**假差异**（11-08 结构图 v4 §九就是被它骗的）；
        //     ② 崩在 finally 前 → 成品留半截/空 ctx.md。
        //   `loadDescription(file)` 一直有 file 形参 —— 回环在 **TMP 副本**上做即可，
        //   成品目录全程只读。判据不降反升：
        //     ①② TMP 副本回环（任何环境都跑满，"只读槽跳过写回环"的降级**取消**）；
        //     ③ 新增默认路断言：CTX_RUN_DESCRIPTION（引擎 import 时用默认路径无参烤出来的）
        //        必须完整等于成品 ctx.md —— 证明"引擎看到的工作描述就是这个文件"。
        const probeDir = fs.mkdtempSync(path.join(TMP, 'g11-desc-'));
        const probeFile = path.join(probeDir, 'ctx.md');
        // ① 真实行为：整份替换成带哨兵的短文案 → 加载结果必须整体跟着变。
        //   （2026-11-05 教训保留：探针必须 ≤ DESC_MAX_BYTES，否则门自炸报"文案坏了"。）
        const probeDoc = 'Example: ctx({op:"run",code:"…"})。\nG11-SENTINEL-文案真源测试行\n';
        fs.writeFileSync(probeFile, probeDoc, 'utf8');
        const loaded = loadDescription(probeFile);
        if (!loaded.includes('G11-SENTINEL'))
            throw new Error('改了 ctx.md 但加载结果没变 —— 描述不是从 .md 来的（被旁路回 JS 了）');
        if (!loaded.includes('Example:'))
            throw new Error('哨兵文案没被整体读入 —— 加载器只读了部分内容？');
        // ② 空文件必须抛 / 缺文件必须抛（静默退内置文案 = 改文案不生效，正是这次要堵的漂移）
        fs.writeFileSync(probeFile, '', 'utf8');
        let threwEmpty = null;
        try { loadDescription(probeFile); } catch (e) { threwEmpty = e; }
        if (!threwEmpty) throw new Error('ctx.md 空了居然没抛 —— 加载器会静默退回 JS 常量');
        let threwMissing = null;
        try { loadDescription(path.join(probeDir, 'nope-not-here.md')); } catch (e) { threwMissing = e; }
        if (!threwMissing) throw new Error('ctx.md 缺了居然没抛 —— 加载器会静默退回 JS 常量');
        // ③ 默认路 == 成品文件（CTX_RUN_DESCRIPTION 是 import 时 loadDescription() 无参烤的）
        if (String(CTX_RUN_DESCRIPTION ?? '').trim() !== orig.trim())
            throw new Error('CTX_RUN_DESCRIPTION ≠ 盘上 ctx.md —— 引擎烤进去的描述不是从这个文件来的（旁路回 JS？）');
        // ④ 倒序形态（2.0 抄的是形态，这条是维护方 11-03 定的判据）
        const md = orig.trim();
        if (!md.startsWith('Example:'))
            throw new Error('ctx.md 首行不是 Example —— 2.0 倒序形态（Example→必填→是什么→表）没落实');
        // ★ 2026-11-05：红线在这里显式量一次 —— 原来它只在 loadDescription 里以
        //   "抛异常"的形态出现，被①的写法搅成假失败。现在门自己报数字。
        const mdBytes = Buffer.byteLength(md, 'utf8');
        if (mdBytes > 1563)
            throw new Error(`ctx.md ${mdBytes} B > 1563 B（≈300 token；折叠后模型只看得到这一个壳，描述红线）`);
        // 注册出来的描述与 op:list 必须同为这份 .md 的内容（同一口径去占位符行）
        const stripVar = (t) => t.split('\n')
            .filter((l) => !l.includes('{{webSearchUrl}}') && !/^\s*WEB:/.test(l))
            .join('\n').trim();
        const listText = String((await engine.call('ctx', { op: 'list' }))?.content?.[0]?.text ?? '');
        if (stripVar(listText) !== stripVar(md))
            throw new Error('op:list 的自描述与 ctx.md 不一致 —— 文案被旁路回 JS 了？');
        const regDesc = engine.module.REGISTERED_CTX_TOOLS.find((r) => r.name === 'ctx').config.description;
        if (stripVar(regDesc) !== stripVar(md))
            throw new Error('注册的工具描述与 ctx.md 不一致 —— attachBridgeContract 没取 .md？');
        // （2026-11-08：原"只读槽跳过写回环"的 ⓘ 提示行已删 —— 写回环改在 TMP 副本上做，
        //   任何环境都跑满，不再有降级判据。）
    });

    // ────────── ⑩ 沙箱归一的结构性反证（P4/P5 之后桥必须只是翻译层） ──────────
    //
    // 判据不是数字符串，是守架构：受限执行**只允许**发生在引擎里。
    //   a. platform/ 任何文件不许 import child_process / spawn / execFile ——
    //      guard（sandbox-exec）当年就是在这层"替引擎跑代码"，才造出
    //      by_tool 恒 0 的假围栏；它复活的方式一定是重新起进程，扫这个形状就能抓。
    //   b. ours/ 增强件不许 import 引擎或 platform 内部模块（web-search 的 Python
    //      抓取桥除外 —— 那是 op:search 的实现底座，经 deps.web 注入进引擎，
    //      不是"桥里跑用户代码"）。
    //   c. ours/sandbox-exec.js 不许存在（OBSOLETE 已守成品；这里连开发区一起守）。
    await check('⑩ 桥=纯翻译层：platform/ 零执行路径，guard 文件不存在', () => {
        const EXEC_SHAPE = /from\s+'node:child_process'|require\('node:child_process'\)|\bspawn(Sync)?\s*\(|\bexecFile(Sync)?\s*\(|\bexecSync\s*\(/;
        const offenders = [];
        for (const f of fs.readdirSync(path.join(argDir, 'platform')).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(argDir, 'platform', f), 'utf8');
            const lines = src.split('\n');
            lines.forEach((l, i) => {
                const code = l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
                if (EXEC_SHAPE.test(code)) offenders.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
            });
        }
        if (offenders.length > 0)
            throw new Error(`platform/ 里出现了执行路径（受限执行只能在引擎里）：\n    ${offenders.slice(0, 5).join('\n    ')}`);
        if (fs.existsSync(path.join(argDir, 'ours', 'sandbox-exec.js')))
            throw new Error('ours/sandbox-exec.js（桥侧 guard）复活 —— P4 已把它整件删除');
        // b. ours/ 不许反向 import 引擎（依赖只准往下：引擎不认识桥，桥递能力进 deps）
        // ★ N8 批次 1 · D4（票面 11 v0.5-v0.6）：守门从"ours 顶层 .js"扩到**递归含
        //   engines/ + engines-offline/**，并加两条卡专属门（禁 TLA / 活卡禁 import offline）。
        //   背景实测（某次实测）：原写法 readdirSync 只扫顶层 ⇒ 17 张卡完全不受 BACK 守门。
        //   递归**不许沿用参考实现上面 platform 段的顶层 readdirSync**，必须目录遍历（连带钉 c 条）。
        //   跑侧（修法 A）：三门只在**成品侧**跑（argDir=releases/1.0.0）；开发区侧 --dir
        //   两种指法均禁入——overlay 缺 engine/index.mjs 被 L78 前置校验拒，repo 根过 L78
        //   但无 ours/ 会静默跳段 = 假绿。等价覆盖由 assemble-release 的 D1 门断言
        //   （两处 ours 逐件哈希全等）保证，故 D1 门必须先于本门跑（某次实测 执行顺序钉）。
        const oursDir = path.join(argDir, 'ours');
        if (!fs.existsSync(oursDir))
            throw new Error(`ours/ 不存在（${oursDir}）—— 守门不许静默跳过（v0.5 连带钉 b）`);
        const jsFiles = [];
        const walkOurs = (d, rel) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walkOurs(p, `${rel}${e.name}/`);
                else if (e.name.endsWith('.js')) jsFiles.push(`${rel}${e.name}`);
            }
        };
        walkOurs(oursDir, '');
        {
            const BACK = /from\s+'[^']*\/engine\/|import\(['"][^']*\/engine\//;
            for (const rel of jsFiles) {
                const src = fs.readFileSync(path.join(oursDir, rel), 'utf8');
                if (BACK.test(src)) throw new Error(`ours/${rel} 反向 import 了引擎 —— 分层倒了（能力经 deps 注入，不 import）`);
            }
        }
        // 卡专属门②：禁 TLA。**判据 = Node 自己的权威判定（S5 复核 某次实测 定夺方案 i）**：
        //   对每张卡 createRequire(成品包根/anchor.js) 后 require(卡绝对路径)——
        //   含 TLA 的 ESM 图 require 必抛 ERR_REQUIRE_ASYNC_MODULE，无 TLA require OK。
        //   为什么权威：TLA 的定义就是"让模块图变 async"，Node 判 async graph 的唯一
        //   信号即此错误码 ⇒ 零启发式、零残留洞。演进记档：行首正则（漏 const/export const
        //   x=await 两型，某次实测 CON）→ 花括号深度 0（I 对象属性/K 裸块/L if 块/M for 块
        //   四型真 TLA 仍豁免，某次实测 挂起判别实测）→ 本判据（14 例 + 24 真卡实测全过）。
        //   前提（均实测）：① 成品包根 package.json type=module（否则报 ERR_REQUIRE_ESM
        //   ⇒ 判据失效，下面单列报错）；② 同进程先 import 过整链再 require 单卡仍能检出
        //   ⇒ 与本门早前 import 无顺序冲突；③ 卡顶层零副作用（只 export default）。
        //   注：修法 A 本门只在成品侧跑，天然满足①；将来开发区侧（修法 B）需自备
        //   type:module 锚点目录。
        {
            const cardFiles = jsFiles.filter((f) => /^(engines|engines-offline)\//.test(f));
            const reqCards = createRequire(path.join(argDir, 'anchor.js'));
            const tla = [];
            for (const rel of cardFiles) {
                const abs = path.join(oursDir, rel);
                try { reqCards(abs); }
                catch (e) {
                    if (e.code === 'ERR_REQUIRE_ASYNC_MODULE') tla.push(`${rel}（含顶层 await：该 ESM 图为 async graph）`);
                    else if (e.code === 'ERR_REQUIRE_ESM' || e.code === 'ERR_REQUIRE_ESM_MODULE')
                        throw new Error(`卡 ${rel} require 报 ${e.code} —— 包根 type≠module，TLA 判据失效，检查 ${argDir}\\package.json`);
                    else tla.push(`${rel}（require 异常：${e.code || String(e.message).split('\n')[0]}）`);
                }
            }
            if (tla.length) throw new Error(`卡片未过 TLA 守门（02 v1.3 钉死项 1；判据 = Node async-graph 权威判定）：\n    ${tla.join('\n    ')}`);
        }
        // 卡专属门③：活卡（engines/）禁 import engines-offline/（永不 import 语义，钉死项 7）。
        //   offline 壳卡允许 import ../ws-engines.js 取 parser（钉死项 3 ③），方向只禁这一边。
        {
            const offenders = [];
            for (const rel of jsFiles.filter((f) => /^engines\//.test(f))) {
                const src = fs.readFileSync(path.join(oursDir, rel), 'utf8');
                if (/from\s+'[^']*engines-offline\/|import\(['"][^']*engines-offline\//.test(src))
                    offenders.push(rel);
            }
            if (offenders.length)
                throw new Error(`活卡 import 了 engines-offline/（离线卡永不 import）：${offenders.join(', ')}`);
        }
        console.log(`  ✓ ⑩-D4 守门：ours 递归 ${jsFiles.length} 件（含卡片 ${jsFiles.filter((f) => /^(engines|engines-offline)\//.test(f)).length} 件）三查通过`);
    });

    // ────────── ⑪ 参数表不许是空的（2026-11-06 S9.37） ──────────
    //
    // ★ 为什么这道门必须有：
    //   2026-11-05 那次事故（喂 JSON Schema 给要扁平表的宿主）与 2026-11-06 那次
    //   （喂扁平表给要 JSON Schema 的宿主）**症状完全一样**：工具照样能调，
    //   只有参数提示消失 —— 宿主界面显示「（无参数）」，模型看不到任何参数名。
    //   这叫**静默降级**，不写死判据就必然复发。
    //
    //   根因回忆：我们走的是 `ctx.tools.register(裸对象)`（不是 `defineTool`），
    //   宿主 `schemaOf()` **原样保留** `definition.parameters` 并按 JSON Schema 读。
    //   所以交出去的必须是 `{type:'object', properties:{…}, required:[…]}`。
    //
    // ★ S9.38 追加两条判据（维护方决定「参数表瘦身」，只留 run/recall）：
    //   ⑪-b **参数表恰好是约定的 11 个**（含顺序）——
    //      防止以后有人"顺手加一个参数"就把 token 又推回去，且没人发现。
    //   ⑪-c **被移走的 22 个参数，每个都必须在 ctx.md 正文里出现** ——
    //      这是"信息不丢"的唯一硬保证。移走的参数宿主照样能传（不裁剪），
    //      但模型要能知道它们存在，就必须在正文/技能里找得到。
    //
    // ★ S9.39：`background` **不进**这两个清单 ——
    //   它既不是"信息搬到别处"（ctx.md 里没有它），也不是"暂时无需求所以移走"，
    //   而是**维护方明令从工具定义删掉**（实测宿主环境不支持：has no live agent）。
    //   引擎侧能力保留（13-sandbox 的 jobHost 分支 + platform/job-host.js 适配器），
    //   删的只是"模型能看到的参数提示"。若将来宿主支持了，把 `background`
    //   加回 EXPECTED_PARAMS 即可 —— **本门会立刻发现漏加**。
    const EXPECTED_PARAMS = [
        'op', 'language', 'code', 'file', 'commands', 'timeoutMs', 'intent',
        'sandbox_permissions', 'justification', 'queries', 'source',
        // ★ 2026-11-12（设计确定：案 · 06 项目）：`full` **加回**（清单一度是 13 个）。
        //   理由：`run` 超 5KB 入库的回执一直承诺「取回全文」，而 recall 的乙档窗口化
        //   每块只回 800 B（实测 12 KB 源只回两成）且不说被切了 —— 话术和实现对不上。
        //   `full:true` 是那个承诺的兑现开关。与 `dryRun`/`fix` 同型：**必须声明 type**，
        //   否则调用方按字符串送、引擎的严格相等判据不成立 ⇒ 开关静默失效
        //   （引擎侧已另有宽容判据 `wantsTrue` 认 `'true'`，这里是双保险）。
        //   token 账：+1 个参数（一条 error/description），ctx.md 仍在 1563 B 红线内。
        'full',
        // ★ S9.40（2026-11-06 维护方决定「修 purge」）：`dryRun`/`fix` **加回**。
        //   理由（实测）：移出工具定义后调用方不再按声明值送 ——
        //   `days:3650` 到达引擎是字符串 `"3650"`、`dryRun:false` 是 `"false"`，
        //   而引擎判据是严格相等 ⇒ **真删永远走干跑分支**（假成功）。
        //   声明 type 是双保险（工具层已另有宽容判据 wantsFalse/wantsTrue）。
        'dryRun', 'fix',
    ];
    // ★ 2026-11-09 ④步 CTX 净身（净身版 §三-5 /〔M4〕〔N2 改判〕）：从清单里移出 `'url'` 与 `'query'`。
    //   机理（三方实测定稿）：⑪-c 判据是"词必须在 ctx.md 正文里出现"。
    //   · `query` 原本**仅 ctx.md L5（search 行）一处**承载 ⇒ 摘 L5 必红 ⇒ 必须移出（门职责归本条）。
    //   · `url` 原本还有 L7（index 行 `path|content|url|dir`）承载，但本轮 L7 按 §三-7 改写成
    //     `path|content|dir`（文案诚实：index{url} 已摘，留 url 就是教一个不存在的入口），
    //     ⇒ `url` 也失去正文出处 ⇒ 同批移出。**两者必须同批**，拆开做中途必红。
    //   注意：剩余参数仍在 ctx.md 有出处（path/dir/content/sessionId/pin/title/category/label/
    //   action/tool/scope/id/days/contentType/sort/offset/limit 全在正文），故 ⑪-c 判据不失效。
    const MOVED_PARAMS = [
        'path', 'dir', 'content', 'sessionId', 'pin', 'title', 'category', 'label',
        'action', 'purge', 'tool', 'scope', 'id', 'days',
        'contentType', 'sort', 'offset', 'limit',
    ];
    await check('⑪ ctx 的参数表是 JSON Schema 且参数不为空（不许静默退化成「（无参数）」）', async () => {
        // ★ platform/ 在**开发区**里叫 overlay/platform/，在**成品**里叫 platform/。
        //   本门默认跑的是 releases/1.0.0（成品），但维护方也可能在开发区直接跑 ——
        //   两处都要找得到，否则门会读到不存在的路径、误报"参数表是空的"。
        const platformDir = fs.existsSync(path.join(argDir, 'platform'))
            ? path.join(argDir, 'platform')
            : path.join(argDir, 'overlay', 'platform');
        if (!fs.existsSync(platformDir))
            throw new Error(`找不到 platform/（argDir=${argDir}，试过 ${argDir}\\platform 与 ${argDir}\\overlay\\platform）`);
        const { toDefinition } = await import(pathToFileURL(path.join(platformDir, 'tool-def.js')).href + `?t=${Date.now()}`);
        const cat = await import(pathToFileURL(path.join(platformDir, 'engine-catalog.js')).href + `?t=${Date.now()}`);
        const def = toDefinition(cat.catalogFromEngine(engine.module.REGISTERED_CTX_TOOLS)[0], {
            callTool: async () => ({ content: [{ type: 'text', text: '' }] }),
        });
        const p = def?.parameters;
        if (!p || typeof p !== 'object') throw new Error('parameters 不是对象');
        if (p.type !== 'object') throw new Error(`parameters.type = ${p.type}，应是 'object'（宿主按 JSON Schema 读）`);
        if (!p.properties || typeof p.properties !== 'object' || Array.isArray(p.properties))
            throw new Error('parameters.properties 不是对象 —— 宿主读不到参数名（会显示「（无参数）」）');
        const keys = Object.keys(p.properties);
        if (keys.length === 0) throw new Error('parameters.properties 是空的 —— 界面会显示「（无参数）」，模型看不到任何参数名');
        // 必须有 op 与 code：这两个是 ctx 最常用的入口
        for (const must of ['op', 'code', 'commands']) {
            if (!keys.includes(must)) throw new Error(`parameters 缺关键参数 ${must}（现有：${keys.join(',')}）`);
        }
        // 每个属性都要有 description：参数露出来了就得说清自己干什么
        const noDesc = keys.filter((k) => {
            const d = p.properties[k]?.description;
            return typeof d !== 'string' || d.trim().length === 0;
        });
        if (noDesc.length > 0) throw new Error(`这些参数没有 description：${noDesc.join(',')}`);
        // required 必须在根上，属性上不许留 required 键（宿主 assertAuthorKeys 不认）
        const strays = keys.filter((k) => Object.hasOwn(p.properties[k], 'required'));
        if (strays.length > 0) throw new Error(`属性上残留 required 键：${strays.join(',')}（宿主要它收在根 required 数组里）`);
        if (!Array.isArray(p.required) || !p.required.includes('op'))
            throw new Error(`parameters.required 应是含 'op' 的数组，实际 ${JSON.stringify(p.required)}`);
        // 必须能过结构化克隆边界（宿主要把它递进 IPC）
        try { structuredClone(p); }
        catch (e) { throw new Error(`parameters 不可结构化克隆：${e.message}`); }

        // ★ ⑪-b（2026-11-06 S9.38）：参数表**恰好**是约定的清单（含顺序）。
        //   为什么要钉死：token 账是维护方关心的硬指标（988 → 576 → 本轮更低）。
        //   "顺手加一个参数"就会悄悄把它推回去，而没有任何症状 —— 必须有门拦。
        //   ★ S9.39：12 → 11（删 `background`，维护方决定；实测宿主环境不支持）。
        //   ★ S9.40：11 → 13（加回 `dryRun`/`fix`，带 type —— 实测移出后调用方按字符串送，
        //     引擎的严格相等判据不成立 ⇒ 真删永远走干跑，假成功）。
        if (keys.length !== EXPECTED_PARAMS.length || keys.some((k, i) => k !== EXPECTED_PARAMS[i])) {
            throw new Error(
                `parameters 应恰好是约定的 ${EXPECTED_PARAMS.length} 个且顺序一致（run 全套 + recall 2 + dryRun/fix）。\n`
                + `  期望：${EXPECTED_PARAMS.join(',')}\n`
                + `  实际：${keys.join(',')}\n`
                + `  ⇒ 多出的参数会把 token 推回去（S9.37 时 34 个 = 988 token；S9.38 起 11~13 个）。\n`
                + `  ⇒ 要加参数先改这条期望清单，并重新算 token 账。`,
            );
        }
        // ★ S9.40 追加：布尔开关必须有 type:'boolean'。
        //   没有 type 的布尔参数会被调用方按字符串送（实测 `"false"`），
        //   而引擎判据是严格相等 ⇒ 开关失效、静默走错分支。门要守住这个形状。
        //   ★ 2026-11-12：`full` 同批纳入（recall 全文开关，与 dryRun/fix 同型）。
        for (const boolKey of ['dryRun', 'fix', 'full']) {
            const spec = p.properties[boolKey];
            if (!spec || spec.type !== 'boolean') {
                throw new Error(
                    `参数 ${boolKey} 必须是 type:'boolean'（S9.40：没有 type 会被调用方按字符串送，`
                    + `引擎的严格相等判据就不成立 ⇒ 开关静默失效）。实际：${JSON.stringify(spec)}`,
                );
            }
        }

        // ★ ⑪-c（2026-11-06 S9.38）：被移走的参数**每个都必须在 ctx.md 正文里出现**。
        //   这是"信息不丢"的硬保证：移走的参数宿主照样能传（宿主不按 schema 裁参数），
        //   但模型得能从描述正文/技能里知道它们存在、叫什么、怎么用。
        //   ★ S9.40：22 → 20（`dryRun`/`fix` 加回工具定义，不再算移走）。
        const mdPath = path.join(argDir, 'engine', 'blocks', '14-tools', 'descriptions', 'ctx.md');
        if (!fs.existsSync(mdPath)) throw new Error(`找不到 ctx.md：${mdPath}`);
        const md = fs.readFileSync(mdPath, 'utf8');
        const missingInMd = MOVED_PARAMS.filter((k) => !md.includes(k));
        if (missingInMd.length > 0) {
            throw new Error(
                `这些参数已从工具定义移走，但 ctx.md 正文里查不到：${missingInMd.join(',')}\n`
                + `  ⇒ 移走的参数在模型可见的正文里必须有出处（op 行的必填参数速查，或指向 SKILL）。\n`
                + `  ⇒ 补进 ctx.md（≤1563 B 红线）或相应 ctx-op-* SKILL，再重跑本门。`,
            );
        }
    });
}
catch (error) {
    fail('装配期致命错误', error instanceof Error ? error.message : String(error));
}
finally {
    // ★★ 2026-11-04 实测：**必须先关掉每一个 DB 句柄，目录才删得掉。**
    //   引擎/客户端对象持有 content.db / -wal / -shm，句柄开着时
    //   `fs.rmSync` 在受限宿主下静默 EPERM（被 catch 吞）→ 目录残留。
    //   本门会开多个 holder（主引擎 + ④b + ⑤ 的客户端），逐个关。
    for (const h of holders) {
        try {
            if (typeof h.retire === 'function') h.retire();
            else if (typeof h.dispose === 'function') h.dispose();
        }
        catch { /* 已在别处关过 */ }
    }
    holders.length = 0;
    releaseTempRunDir(TMP);
}

console.log('\n' + '─'.repeat(60));
const total = passed + failures.length;
console.log(`G11 工具面一致性：${total} 项 / 失败 ${failures.length}`);
// ★ 机器可读行：GBK 控制台下中文会变乱码，调用方按这行 + 退出码判定。
console.log(`G11_SUMMARY total=${total} failed=${failures.length} status=${failures.length > 0 ? 'FAIL' : 'PASS'}`);
if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  · ${f}`);
    console.log('\nG11 不通过 ❌');
    process.exit(1);
}
console.log('G11 全绿 ✅ —— 工具面只有 ctx，旧名没有兜底也没有残留');
