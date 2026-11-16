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
 * index.mjs — 引擎唯一入口（D1 的核心）
 *
 * 干什么：三种形态共用同一份 blocks ——
 *   ① createEngine({ctx, confiner})  进程内（DSH 桥用）
 *   ② node index.mjs --selftest      独立跑（无宿主、无 ctx）← G1 门的主角
 *   ③ node server.mjs --agent <name>  MCP stdio（可选，后面再说）
 *
 * 为什么这样：1.2.2 的入口是"加载 .build/server.js"，离开宿主的 zod 就炸；
 *            这里入口自己只有依赖本仓 libs 与 blocks，零外部包。
 *
 * 边界：入口只做"装配 + 暴露工具表 + 生命周期"，不含业务；业务在 17 块里。
 *       **--selftest 期不写真库**：临时库一律落 F:\workspace\LongMem\Temp，跑完自删。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.mjs';
import { createLogger } from './libs/log.js';
import { tempDir as resolveTempDir } from './libs/tempdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = resolveTempDir();

/** 17 块登记表：名字、目录、kind、deps。**加一块 = 这里加一行**（D3②）。 */
export const BLOCK_MANIFEST = [
    { name: 'core', dir: '01-core', kind: 'contract', deps: [] },
    { name: 'project', dir: '02-project', kind: 'impl', deps: ['core'] },
    { name: 'storage', dir: '03-storage', kind: 'impl', deps: ['core', 'project'] },
    { name: 'store', dir: '04-store', kind: 'impl', deps: ['core', 'project', 'storage'] },
    { name: 'analyze', dir: '05-analyze', kind: 'impl', deps: ['core'] },
    { name: 'gram', dir: '06-gram', kind: 'impl', deps: ['core', 'analyze'] },
    { name: 'tokenize', dir: '07-tokenize', kind: 'impl', deps: ['core', 'analyze'] },
    { name: 'writer', dir: '08-writer', kind: 'impl', deps: ['core', 'project', 'store', 'analyze', 'gram', 'tokenize'] },
    { name: 'reader', dir: '09-reader', kind: 'impl', deps: ['core', 'store', 'gram', 'tokenize'] },
    // ★ 顺序即契约：memory 必须在 recall 之前（recall 依赖它）。块编号是给文档看的，
    //   **登记顺序才是依赖拓扑**。2026-11-03 qfmodel 门⑤抓到原来这里排反了。
    { name: 'memory', dir: '11-memory', kind: 'impl', deps: ['core', 'project', 'store'] },
    { name: 'recall', dir: '10-recall', kind: 'impl', deps: ['core', 'reader', 'memory'] },
    { name: 'lifecycle', dir: '12-lifecycle', kind: 'impl', deps: ['core', 'project', 'store'] },
    { name: 'sandbox', dir: '13-sandbox', kind: 'impl', deps: ['core'] },
    { name: 'tools', dir: '14-tools', kind: 'tool', deps: ['core', 'writer', 'reader', 'recall', 'memory', 'sandbox'] },
    { name: 'hooks', dir: '15-hooks', kind: 'impl', deps: ['core', 'recall', 'lifecycle'] },
    { name: 'plugs', dir: '17-plugs', kind: 'crosscut', deps: [] },
    { name: 'entry', dir: '16-entry', kind: 'entry', deps: [] },
];

/** 登记前先拓扑排序：manifest 顺序错了也不许逃过 deps 校验（护栏要在，不是靠人记顺序）。 */
export function topoSortManifest(manifest) {
    const byName = new Map(manifest.map((m) => [m.name, m]));
    const visited = new Set();
    const out = [];
    const visit = (m, stack) => {
        if (visited.has(m.name)) return;
        if (stack.has(m.name)) throw new Error(`BLOCK_MANIFEST 有环：${[...stack, m.name].join(' → ')}`);
        stack.add(m.name);
        for (const d of m.deps ?? []) {
            const dep = byName.get(d);
            if (!dep) throw new Error(`BLOCK_MANIFEST：${m.name} 依赖未知块 ${d}`);
            visit(dep, stack);
        }
        stack.delete(m.name);
        visited.add(m.name);
        out.push(m);
    };
    for (const m of manifest) visit(m, new Set());
    return out;
}

/** 14 个工具面 op（折叠后 ctx 的 op 清单；04-工具需求书 §7.3。
 *  2026-11-04：ctx_recall 并入 op=recall；2026-11-05：新增 op=switch（工具开关，宿主能力）。
 *
 *  ★ 2026-11-06 S9.36（维护方二问："工具已经改成 OP:RUN 了，还提示以前的"）：
 *   `name` 字段原来填的是**旧工具位名**（ctx_search / ctx_recall / ctx_index …），
 *   那些位 2026-11-04 就折叠没了，**现在只有一个工具位 `ctx`**。
 *   旧 `name` 会随 `api.opCatalog` 序列化出去（`--tool-surface` / 自检输出 / 结构化 result），
 *   等于对外报了一批**不存在的工具位** —— 与"文案指向不存在的东西就是撒谎"同族。
 *   现在 `name` 一律是现行位名 `ctx`（op 靠 `op` 字段区分），
 *   旧位名留在 `legacy` 字段里作史实，**不再冒充工具位**。 */
export const OP_CATALOG = [
    { op: 'run', name: 'ctx', legacy: 'ctx_run', required: 'language|code|file|commands', oneLine: '跑代码/命令/批量（12 语言）' },
    // ★ 2026-11-09 ④步 CTX 净身：`search` 行整条摘除（14 → 13 op）。
    //   op:search（query 聚合腿 + url/page 腿 + 反爬五段）随 FP 迁出；CTX 按定义不含 SEARCH
    //   （维护方 13:5x「CTX不包含SEARCH」）。史见净身版 §三-3、原件 §11.3 A-10。
    { op: 'recall', name: 'ctx', legacy: 'ctx_recall', required: 'queries(2-4 词)', oneLine: '本地库召回（三榜 RRF，命中续命）' },
    { op: 'index', name: 'ctx', legacy: 'ctx_index', required: 'path|content|dir 三选一', oneLine: '写进 14 天临时库' },
    { op: 'remember', name: 'ctx', legacy: 'ctx_remember', required: 'title+content+category', oneLine: '手录长久经验' },
    { op: 'pin', name: 'ctx', legacy: 'ctx_pin', required: 'label+category', oneLine: '临时库 → 长久库' },
    { op: 'unpin', name: 'ctx', legacy: 'ctx_unpin', required: 'label', oneLine: '长久库 → 临时库' },
    { op: 'memory', name: 'ctx', legacy: 'ctx_memory', required: 'action', oneLine: '长久库 list/get/setCategory/delete' },
    { op: 'stats', name: 'ctx', legacy: 'ctx_stats', required: '—', oneLine: '省了多少 + 库状态' },
    { op: 'doctor', name: 'ctx', legacy: 'ctx_doctor', required: '—', oneLine: '体检（fix 才修）' },
    { op: 'maint', name: 'ctx', legacy: 'ctx_maint', required: 'action', oneLine: 'plan/retention/optimize/checkpoint/integrity/vacuum' },
    { op: 'purge', name: 'ctx', legacy: 'ctx_purge', required: 'scope', oneLine: '显式清除' },
    { op: 'switch', name: 'ctx', legacy: 'ctx_switch', required: 'action', oneLine: '工具开关 list/off/on（全局+落盘：换会话/重启都保持）' },
    { op: 'list', name: 'ctx', legacy: null, required: '—', oneLine: '不传 op 时返回这张表（自描述）' },
];

/**
 * 进程内创建一个引擎实例。
 * @param {{ctx?:object, confiner?:Function, contentDir?:string, level?:string, tempDir?:string}} [opts]
 */
export async function createEngine(opts = {}) {
    const logger = createLogger({ level: opts.level ?? 'info' });
    const registry = createRegistry({ level: opts.level });

    // ① 装配：先拓扑排序（manifest 顺序错了也不许逃过 deps 校验），再按序登记
    const ordered = topoSortManifest(BLOCK_MANIFEST);
    const missing = [];
    for (const spec of ordered) {
        const dir = path.join(HERE, 'blocks', spec.dir);
        const entryFile = path.join(dir, 'index.js');
        if (!fs.existsSync(entryFile)) { missing.push(spec.dir); continue; }
        const mod = await import(pathToFileURLSafe(entryFile));
        registry.register({ name: spec.name, kind: spec.kind, deps: spec.deps, invariants: mod.INVARIANTS }, mod, dir);
    }
    if (missing.length > 0) {
        logger.forScope('entry').warn(`缺 ${missing.length} 块（未实现）：${missing.join(' ')}`, 'missing-blocks');
    }

    // ② 初始化：confine 由入口注入（宿主给 / 自定义 / selftest 恒等函数）
    //   ★ 桥只交 ctx（宿主 Cordis 上下文），不交 confiner —— 所以这里要**从 ctx 解析沙箱**。
    //     拿不到就退回恒等（引擎独立跑时本来就该无沙箱）。
    const confiner = typeof opts.confiner === 'function'
        ? opts.confiner
        : buildConfinerFromCtx(opts.ctx, (m) => logger.forScope('entry').debug(m));
    const ctx = {
        contentDir: opts.contentDir ?? process.env.CONTEXT_MODE_DIR,
        tempDir: opts.tempDir ?? TEMP,
        confine: confiner ?? ((argv) => ({ argv })),
        confined: confiner !== null,
        log: logger,
        host: opts.ctx ?? null,
        // ★ R17（2026-11-05）：后台作业宿主适配器随 initAll 下发到 13-sandbox。
        //   为 null = 宿主没组作业服务 → 13-sandbox 给"本包未接"的可读拒绝。
        jobHost: opts.jobHost ?? null,
    };
    await registry.initAll(ctx);

    // ②b 真装配：16-entry 把 db + 各块实例拼起来（桥调用时必须有真库，否则"能列出不能干活"）
    let assembled = null;
    let assembleError = null;
    const entryBlock = registry.get('entry');
    if (entryBlock && typeof entryBlock.assemble === 'function' && ctx.contentDir) {
        try {
            assembled = await entryBlock.assemble({
                contentDir: ctx.contentDir,
                registry,
                level: opts.level ?? 'error',
                // ★ 宿主给的能力注入：网页抓取由桥侧传（引擎独立跑时为空 → op=search 给可读错误）
                sandbox: registry.get('sandbox') ?? null,
                web: opts.web ?? null,
                purger: opts.purger ?? null,
                // ★ 2026-11-05 Tool Switch：宿主侧的开关实现（platform 注入）。
                //   引擎只管把它转交给 14-tools，不碰 Cordis。
                toolSwitch: opts.toolSwitch ?? null,
                // ★ 2026-11-05 后台作业（R17）：宿主 `ctx.jobs` 适配器（platform 注入）。
                //   引擎只管把它转交给 sandbox/14-tools —— background:true 的真正来源。
                jobHost: opts.jobHost ?? null,
                // ★ 2026-11-06 S9.44：道 A 真实遥测（platform 注入 ours/recall-hints 的 hintState）。
                //   不注入 → op:stats 回退读引擎 10-recall 那个生产零调用方的池（seenA 恒 0）。
                hintState: opts.hintState ?? null,
            });
            logger.forScope('entry').info('装配完成：真库已打开', 'assembled');
        }
        catch (e) {
            assembleError = e;
            logger.forScope('entry').warn(`装配失败（工具面退回静态表）：${e.code ?? ''} ${e.message}`, 'assemble-failed');
        }
    }

    // ③ 工具面：装配成功就用 14-tools 注册进 registry 的**真实 op**；否则退回静态表（G1 只要求"列出+可克隆"）
    const toolList = registry.opCount() > 0 ? registry.toolList() : OP_CATALOG.map((o) => ({ ...o }));

    const cleanups = [];
    const api = {
        registry,
        logger,
        blocks: registry.list(),
        opCatalog: toolList,
        missingBlocks: missing.slice(),
        assembled,
        assembleError,
        // ★ 2026-11-09 ④步 CTX 净身（净身版 §三-8）：`webUrl` **退役**。
        //   原用途（已留底 BACKUP\engine\index.mjs）：
        //     ctx.md 里的 `{{webSearchUrl}}` 由平台层从这传进来
        //     （EngineClient 注入；引擎独立跑时没有 → fillDescriptionText 删整行）。
        //   现在：占位符所在的那行文案（原 L5 search 行）已摘（§三-7），
        //   供值方 engine-client 的 webUrl 也已退役（§三-15），填充函数本体退役（§三-8）
        //   ⇒ 三件套一起没了，这条参数留着只会让读码的人以为还有占位符要填。
        //   **保留 `webUrl` 同名键会让 G11 ⑨ 的"改动 ctx.md 一个字描述立刻跟着变"那类
        //   对拍看起来还对（因为它只是透传），实际已无人消费 = 假活。**
        //   历史留档：占位符原样漏给模型 = 文案指向不存在的东西（撒谎），当年因此加了这条链。
        get ready() { return missing.length === 0 && assembleError === null; },

        /**
         * 统一调用口。**两种语义要分清**（这是平台层同形的关键）：
         *   · 传工具名 `ctx` → 按工具位走（平台层就是这么调的）
         *   · 传 op 名 `index` / `search` / `recall` … → 直接按 op 分派（引擎内部 / selftest 用）
         * 返回：工具名路走 MCP 形状（`{content:[{type:'text',text}]}`，平台层只读这个）；
         *       op 路走内部形状（`{ok, result, text}`）。
         * 2026-11-04 设计确定：工具面只剩 1 位 —— `ctx_run` 改名 `ctx`，`ctx_recall` 并入
         *   op=recall（"热路径不折叠"原案作废，实测一层 op 转译并不更贵）。
         *   旧名 `ctx_run` / `ctx_recall` **不留兜底**：调用方全在本包内，一次改干净。
         * ★ P2（沙箱归一）第三参 `runtime`：`{signal, session, callId}` —— 宿主每次调用
         *   的执行上下文（取消要能杀子进程、policy 要按会话现解、审批要能挂 callId）。
         *   以前 callTool 收下 exec.signal 就丢（`_signal`），受限路径的取消全靠桥侧
         *   guard；guard 一撤（P4），这条 runtime 就是唯一的取消/会话通道 —— 必须存在。
         */
        async call(nameOrOp, args, runtime) {            // ── 工具名路（平台层同形）──
            if (nameOrOp === 'ctx') {
                if (!api.tools) attachBridgeContract(api, toolList);
                const tool = api.tools.get('ctx');
                if (!tool) return { content: [{ type: 'text', text: `Engine error: no such tool "${nameOrOp}"` }], isError: true };
                try { return await tool.call(args ?? {}, runtime); }
                catch (e) { return { content: [{ type: 'text', text: `${e.code ?? 'ERROR'}: ${e.message}` }], isError: true }; }
            }
            // ── op 路（内部）──
            if (nameOrOp === 'list' || !nameOrOp) {
                return { ok: true, result: { ops: toolList }, text: renderOpTable(toolList) };
            }
            try {
                // ★ 同 bridgeCall：两条 op 表都试（assembled.tools 优先）
                const entry = assembled?.tools?.get?.(nameOrOp) ?? registry.getOp?.(nameOrOp);
                if (!entry) {
                    throw Object.assign(new Error(`没有 op=${nameOrOp}（可用：${(assembled?.tools?.ops?.() ?? []).join(',')}）`), { code: 'UNKNOWN_OP' });
                }
                const out = await entry.call(args ?? {}, runtime);
                return { ok: true, result: out };
            }
            catch (e) {
                return { ok: false, error: { code: e.code ?? 'ERROR', message: e.message }, text: `${e.code ?? 'ERROR'}: ${e.message}` };
            }
        },

        dispose() {
            try { assembled?.close?.(); } catch { /* 忽略 */ }
            for (const fn of cleanups.reverse()) { try { fn(); } catch { /* 忽略 */ } }
            logger.forScope('entry').info('已卸载', 'disposed');
        },
        onDispose(fn) { cleanups.push(fn); },
    };
    attachBridgeContract(api, toolList);
    return api;
}

/**
 * 桥接同形层（D3①：`bridges/` 一行不改就能接上新引擎）。
 *
 * 桥实际只读三样东西（回源 `bridges/engine-client.js`）：
 *   · `this.engine.toolNames`         → 日志里报"注册了几个工具"
 *   · `this.engine.call(name, args)`  → 返回 **MCP 形状** `{content:[{type:'text',text}], isError?}`
 *   · `this.engine.dispose()`
 * 另外 `listTools()` 走 `catalogFromEngine(this.engine.module.REGISTERED_CTX_TOOLS)`，
 * 所以要造一份 `module.REGISTERED_CTX_TOOLS`（形状 `{name, config:{description}, inputSchema, handler}`）。
 *
 * **这不是新契约，是旧契约的复刻**：桥那边一个字都不用动。
 */
/**
 * ~~文案里的平台占位符处理（2026-11-04 文案面进 ctx.md 后新增）~~
 *
 * ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-8 /〔M6〕）：**整件退役**。
 *   原职责：`ctx.md` 的 `{{webSearchUrl}}` 占位符 —— 平台层给了 webUrl 就填真值
 *   （描述按安装位置保持正确）；没给就整行删掉（不许把占位符原样漏给模型）。
 *   为什么现在必须删：
 *     ① 承载该占位符的文案行是原 ctx.md **L5 的 search 行**，已在 §三-7 整行摘除 ⇒
 *        `ctx.md` 里 `{{webSearchUrl}}` 出现 0 次（本轮程序内实测，非肉眼看）；
 *     ② 供值方 `webUrl` 也已从 engine-client 的 createEngine 调用里退役（§三-15）；
 *     ③ ⇒ 填充逻辑对任何文本都走 `return text` 一条路 = **纯空转**。
 *   保留它会怎样：一条永远不触发的死分支 + 一个没人传的参数，读码的人会以为
 *   "文案里还有占位符要填"，从而去找一个已经不存在的 search 行（撒谎的注释）。
 *   历史价值留档：这条逻辑当年解决的是真问题 —— 占位符原样漏给模型，
 *   与"文档教模型调不存在的工具"同族（文案指向不存在的东西，就是撒谎）。
 */
/**
 * 注入前的最小形状整理。
 *
 * ★ 净身副作用说明：原 `attachBridgeContract` 里对 description 做 `fillDescriptionText(...)`，
 *   现在直接取真源（14-tools 模块 import 时已加载并校验过 ≤1563B 红线）。
 */
function attachBridgeContract(api, opCatalog) {
    // 一个工具位：ctx（13 个 op 折叠成壳；2026-11-04 recall 并入，2026-11-05 switch 新增，
    // 2026-11-09 search 迁 FP 摘除）。
    // 描述真源 = `blocks/14-tools/descriptions/ctx.md`（14-tools 模块 import 时就加载好了，
    // registry.get('tools') 拿到的就是那个模块）。缺文案的情况到不了这里 ——
    // 14-tools 模块 import 当场抛（loadDescription 不静默退 JS 常量）。
    // 下面 ?? 那条只在 14-tools 整块缺失（missing 登记过）时兜底，让工具面还能自描述。
    const description = api.registry?.get?.('tools')?.CTX_RUN_DESCRIPTION ?? ctxRunDescription(opCatalog);
    const registered = [];
    registered.push({
        name: 'ctx',
        config: { description },
        inputSchema: ctxRunSchema(opCatalog),
        handler: async (args, runtime) => bridgeCall(api, args?.op ?? 'list', args, runtime),
    });

    api.module = { REGISTERED_CTX_TOOLS: registered };
    api.toolNames = registered.map((r) => r.name);
    api.tools = new Map(registered.map((r) => [r.name, {
        name: r.name,
        description: r.config.description,
        inputSchema: r.inputSchema,
        call: (args, runtime) => r.handler(args, runtime),
    }]));
    return api;
}

/** op 分派 → MCP 形状。平台层只看 content[0].text，所以"文本必须是给人/模型看的"。 */
async function bridgeCall(api, op, args, runtime) {
    try {
        // ★ 2026-11-04：op=recall 不再走旁路。ctx_recall 并入 op 之后，
        //   召回和 index/stats 一样是 registry 里的**真实 op 条目**（14-tools 的 reg('recall')），
        //   走下面同一条分派路 —— 少一个特判，就少一处"门绿了但真机没走"的盲区。
        // op 走 registry 的**真实 op 条目**（14-tools 通过 `reg()` 注册进去的那个）。
        // 它返回 `{ result, text }`；这里必须把 text 取出来 —— 取不到就说明
        // 有 op 没写 text（那是 bug，要报出来，不是静默回空串）。
        //
        // ★ 2026-11-04 更正一条**实现方自己判断错**的结论（写在这免得后人重踩）：
        //   当时真机上 `ctx_run({op:'stats'})` 全部返回
        //     `UNKNOWN_OP: 没有 op=stats（可用：run,search,...,stats,...）`
        //   实现方一度判定为"14-tools 的 ops Map 与 registry.tools 是两张表、接错了"。
        //   **这是错的。** 实测：只要装配成功，`registry.getOp('stats')` 就能查到，
        //   `registry.toolList().length === 12`。
        //   真正的理由是**装配失败**（`createEngine` 的 contentDir 落在不可写位置，
        //   `assembleError = EPERM`，`assembled = null`）→ `ctx.toolsFactory` 从未被调用
        //   → registry 里一个 op 都没注册 → 于是每个 op 都 UNKNOWN_OP。
        //
        //   错误文案之所以自相矛盾（"没有 op=stats"却又列出 stats），是因为
        //   `api.opCatalog` 是**静态清单**（引擎常量），而 `registry` 是**运行时表**；
        //   装配失败时前者有 12 项、后者 0 项。它其实在如实报告这个不一致 ——
        //   只是文案没解释"清单里有但运行时没注册"。
        //
        //   所以这里保留 `assembled.tools.get(op)` 作为**防御性回退**（多一条路不会更坏），
        //   但根因在装配，不在查表。G10/G11 之所以没抓到，是因为它们在可写目录里跑。
        const entry = api.assembled?.tools?.get?.(op) ?? api.registry.getOp?.(op);
        if (entry) {
            const out = await entry.call(args ?? {}, runtime);
            // ★ 2026-11-09 净身：原来这里对 out.text 再做一次 `fillDescriptionText(…, api.webUrl)`
            //   （理由：op:list 的文本就是 ctx.md 本体，占位符不许原样漏给模型）。
            //   该函数已随占位符本体整件退役（见其上方注释），ctx.md 现零占位符 ⇒ 直接原样返回。
            const text = out?.text ?? '';
            return text ? mcpText(text) : mcpText(`(op=${op} 返回空文本：该 op 的 handler 没写 text 字段)`);
        }
        if (op === 'list' || !op) {
            return mcpText(renderOpTable(api.opCatalog));
        }
        return { content: [{ type: 'text', text: `UNKNOWN_OP: 没有 op=${op}（可用：${api.opCatalog.map((o) => o.op).join(',')}）` }], isError: true };
    }
    catch (e) {
        return { content: [{ type: 'text', text: `${e.code ?? 'ERROR'}: ${e.message}` }], isError: true };
    }
}

function mcpText(text) {
    return { content: [{ type: 'text', text: String(text) }] };
}

/** ctx 壳的描述兜底：自足 + ≤1563 B（≈300 token；折叠后模型看不到 14 个独立 schema）。
 *  ★ 正路永远是 14-tools 的 descriptions/ctx.md（loadDescription 读它）；
 *    这个函数只在 14-tools 没装配时兜底，所以它的上限必须跟 DESC_MAX_BYTES 对齐。 */
function ctxRunDescription(opCatalog) {
    const rows = opCatalog.map((o) => `${o.op} ${o.oneLine}`);
    const body = rows.join('｜');
    const head = 'ctx — 一个壳，按 op 分派下列能力（不传 op 返回这张表）。';
    let text = `${head}\n${body}\n真删（retention/vacuum/purge:project）默认只报数，必须显式 dryRun:false。`;
    if (Buffer.byteLength(text) > 1563) text = `${head}\n${rows.join('｜')}`;
    return text.slice(0, 1563);
}

/**
 * ctx 壳的 schema：**纯 JSON**，零 zod（1.2.2 结构化克隆事故的护栏）。
 *
 * ★★ 2026-11-06 S9.38（维护方决定「参数表瘦身」）：**只留 run/recall 常用参数**。
 *
 * 为什么可以只留一部分
 * ─────────────────────────────────────────────────────────
 * 宿主**不按 schema 裁参数**（三条独立证据，见开发日志 S9.38）：
 *   ① S9.37 修之前参数一个都不显示，ctx **照样能正常跑**（11-05 整个会话都在用）；
 *   ② 宿主 `dsh-tools/lib/types/json-schema.js:492` —— 只有 `additionalProperties:false`
 *      才拒绝未声明属性，**我们没设**；同文件 :477 只对已声明属性做类型校验；
 *   ③ 平台层 `overlay/platform/tool-def.js:241` `const forwardArgs = { ...args };` —— 全量转发。
 * ⇒ **参数表只是"提示面板"，不是"契约"。** 移走的参数照样能传、照样能用。
 *
 * 移走的参数信息**不会丢**（两条覆盖）：
 *   · `blocks/14-tools/descriptions/ctx.md` 的 op 行**本来就逐条列了每个 op 的必填参数**
 *     （search query|url / index path|content|url|dir / remember title+content+category /
 *      pin label+category / memory action…（get 认 id/label）/ maint action… /
 *      purge scope… / switch action… tool）；
 *   · 冷 op 的**可选参数**由 SKILL 覆盖（ctx-op-search / ctx-op-index / ctx-op-stats / ctx-op-purge）。
 *
 * 为什么裁得起（本会话实测调用频次：run≈46、recall=4、其余各 1–2）
 * ─────────────────────────────────────────────────────────
 * · **run 全套 10 个**：`run` 是绝对主力；`code`/`language`/`commands`/`file` 是四种跑法；
 *   `timeoutMs`/`background`/`intent` 每次大输出都要用；
 *   `sandbox_permissions`+`justification` 走 run 路径（宿主提权审批）。
 * · **recall 2 个**（`queries`+`source`）：recall 次数少但**离不了** ——
 *   >5KB 的 run 结果入库后只能靠 recall 取回正文。
 *   `sort`/`offset`/`limit`/`contentType` 本会话一次没用过 ⇒ 移走。
 *
 * ★ 账（宿主口径 `ceil(JSON.stringify(tools).length/4)+4`）：
 *   空表 262 → 11-05 修好后 684（34 参）→ S9.37 后 988（34 参 + 34 描述）
 *   → **本轮 576（12 参）**。省 412 token。
 *   其中参数名本身只占 52 token，**描述文字占 534 token** —— 涨的多是说明，不是参数。
 *
 * 2026-11-04 的一条旧规矩仍成立：recall 并入 op 后，
 * source/contentType/sort/offset **必须在 schema 里**，否则 op=recall 的过滤参数
 * 在宿主 schema 层就被剥掉（引擎侧读 args.source 会拿到 undefined）。
 * ★ S9.38 修正：那条判断的前提是"宿主会剥"，实测**不剥**（上面证据 ②）——
 *   所以移走 `contentType`/`sort`/`offset` **不会**导致 op=recall 过滤失效。
 *   留 `source` 是因为 recall 必用它；其余三个在本会话一次没用过。
 */
function ctxRunSchema(opCatalog) {
    return {
        type: 'object',
        properties: {
            // ── run 全套 ──────────────────────────────────────────────
            op: { type: 'string', enum: opCatalog.map((o) => o.op), description: '要调哪个能力；不传 = 返回 op 表' },
            language: { type: 'string', enum: ['javascript', 'typescript', 'python', 'shell', 'ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp'], description: '跑哪种语言，默认 javascript（shell = 系统命令）' },
            code: { type: 'string', description: '要跑的脚本正文（与 commands 互斥，只给一个）' },
            file: { type: 'string', description: '只把绝对路径塞进 CTX_FILE，正文仍要走 code' },
            commands: { type: 'array', items: { type: 'string' }, description: '批量命令，扁平字符串数组（如 ["dir","echo hi"]）；不许嵌套数组；与 code 互斥' },
            timeoutMs: { type: 'number', description: '超时毫秒数' },
            intent: { type: 'string', description: '输出超 5KB 入库后，带 intent 让引擎按它选好块直接回正文' },
            // ★ P5 审批流（2026-11-04）：与宿主 pwsh 平权的两个字段。语义与校验都归
            //   宿主 dsh-sandbox（platform 层 validateEscalationArgs + approveEscalation），
            //   引擎只把它们随 runtime 递上去 + 认 policyOverride。enum 不写死在这：
            //   模式表是宿主的，引擎抄一份 = 两份实现漂移（老账）。
            sandbox_permissions: { type: 'string', description: '仅在被拒后重试同一次调用时带：申请更宽的沙箱模式（宿主审批，一次一批）' },
            justification: { type: 'string', description: '申请理由（给维护方看的），与 sandbox_permissions 成对' },
            // ── recall 必需的两个 ─────────────────────────────────────
            queries: { type: 'array', items: { type: 'string' }, description: '2-4 个具体词（也接受单个字符串或 JSON 数组字符串，2026-11-04 真机宽容）' },
            source: { type: 'string', description: '按来源标签过滤（recall 也可按 source 取回某次 run 的入库结果）' },
            // ★ 2026-11-12（设计确定：案）：`full` **必须进 schema**。
            //   理由与 `dryRun`/`fix` 同型：不声明 = 调用方有权按自己的形状送值，
            //   而引擎侧 `wantsTrue` 认 `true`/`'true'`/`1` 三种；声明成 boolean
            //   能让调用方少一道字符串化。语义：recall 要**整源全文**，不要 800 B 窗口。
            full: { type: 'boolean', description: 'recall 全文开关：给 true 时整源原样拼回（≤64KB），默认只回片段' },
            // ★ S9.40（2026-11-06 维护方决定「修 purge」）：把 `dryRun`/`fix` **加回**工具定义（带 type）。
            //   为什么加回来：S9.38 把它们移出后，调用方不再按声明类型送值 —— 实测真机
            //   `days:3650` 到达引擎是字符串 `"3650"`、`dryRun:false` 是 `"false"`，
            //   而引擎判据是严格相等 ⇒ **真删永远走干跑分支**（假成功）。
            //   声明 type 是**双保险**：工具层已改成宽容判据（wantsFalse/wantsTrue），
            //   这里再让调用方看见类型，少一道字符串化。
            //   `days`/`limit`/`offset` 仍留在正文（info 不丢，由 ctx.md 的 op 行与 skill 覆盖）。
            dryRun: { type: 'boolean', description: '真删开关：给 false 才真删（默认干跑，不可撤销）' },
            fix: { type: 'boolean', description: 'doctor 修复开关：给 true 才做可逆维护' },
            // ── 以下 20 个参数在 S9.38 移出工具定义（信息不丢：ctx.md 逐行列了每个 op
            //    的必填参数，冷 op 的可选参数由 ctx-op-* SKILL 覆盖）──────────────────
            //   index: path / dir / content / url / pin / category / sessionId
            //   search: query
            //   remember: title / content / category
            //   pin/unpin: label / category
            //   memory: action / id / limit
            //   stats/doctor/maint: action / days
            //   purge: scope / purge
            //   switch: action / tool
            //   recall 的可选过滤: contentType / sort / offset / limit
            //
            // ★ `background`（S9.39）：**暂时无需求，维护方决定从工具定义删掉**。
            //   实测 `background:true` → `SANDBOX_ERROR: has no live agent`
            //   （宿主要求后台作业 owner 是 live agent，本环境没有 ⇒ 必败）。
            //   本会话调用 0 次；且 ctx 是独占的（要写库、不能并发跑两个），
            //   "跑很久 + 同时干别的"这个场景在 CTX 设计里不成立 ——
            //   `run` 已有 timeoutMs（30 分钟）+ >5KB 自动入库 + intent 选块，一条就够。
            //   ★ 删的是**参数提示**，不是功能：引擎侧 `13-sandbox` 的 jobHost 分支与
            //     `platform/job-host.js` 适配器**原样保留**，宿主哪天支持了就能接回去。
            //   ★ `ctx-op-run/SKILL.md` 里那条 background 教学**一并删了** ——
            //     否则模型读了 skill 还是会去试那个坏开关。
        },
        required: ['op'],
    };
}

/**
 * 从宿主 Cordis ctx 解析出 confine（2.0 `assembly/seam` 契约 + P2 逐会话化）。
 *
 *   ctx.get('sandbox')        SandboxProvider，有 .confine(argv, policy, signal)（async）
 *   ctx.get('sandboxPolicy')  策略解析器，.resolve({session})（可能 async）
 *
 * 拿不到 sandbox 服务 → 返回 null（引擎独立跑 = 无沙箱，不是报错）。
 * ★ P1/P2 修的两件事：
 *   1. 旧版同步 resolve 不传 session，异步直接放弃、兜底 process.cwd() —— 现在**逐调用**
 *      按 session 现解 policy（guard 四年就是这么做的）；
 *   2. 旧版没 await 宿主 async confine，Promise 上取 .argv 恒 undefined → 假围栏。
 *      现在返回的 confiner 是 async，13-sandbox 会 await；**fail-closed**：
 *      resolve/服务任何一步坏 → null → CONFINER_UNAVAILABLE，绝不原样放行。
 *
 * confiner 附挂 `describe(meta)`：起进程**之前**探本会话是否受限（不重写 argv）：
 *   → { enforcement: 'confined'|'none', workspaceRoot, mode } | null
 *   'none' = danger-full-access（宿主说没得 enforced）→ 12 语言/无捕获顶照常；
 *   'confined' = 白名单/512KB 顶/拒 background/超时钳位生效；
 *   null = 解析失败 → 调用方拒跑（fail-closed）。
 *
 * @param {object|undefined} hostCtx
 * @param {(msg:string)=>void} [log]
 * @returns {((argv:string[], meta?:object)=>Promise<{argv:string[]}|null>) & {describe?:(meta?:object)=>Promise<object|null>} | null}
 */
export function buildConfinerFromCtx(hostCtx, log = () => { }) {
    const sandbox = hostCtx?.get?.('sandbox');
    if (!sandbox || typeof sandbox.confine !== 'function') return null;
    const policySvc = hostCtx?.get?.('sandboxPolicy');

    /** 逐会话解 policy；解不出返回 null（调用方 fail-closed）。 */
    async function resolvePolicy(meta) {
        if (!policySvc) return null;
        if (typeof policySvc.resolve === 'function') {
            try {
                const session = meta?.session;
                const p = await policySvc.resolve(session === undefined ? {} : { session });
                if (p && typeof p.mode === 'string') return p;
                log(`sandboxPolicy.resolve 返回形状不认识：${JSON.stringify(Object.keys(p ?? {}))}`);
                return null;
            }
            catch (e) {
                log(`sandboxPolicy.resolve 失败：${e?.message ?? e}`);
                return null;
            }
        }
        if (typeof policySvc === 'object' && typeof policySvc.mode === 'string') return policySvc;
        return null;
    }

    const FULL_ACCESS = 'danger-full-access';
    const confiner = async (argv, meta = {}) => {
        // ★ P5：policyOverride = 宿主刚批准的一次性 mode（批准动作发生在平台层
        //   approveEscalation，引擎只认"这次调用按批准的 mode 走"——与 pwsh 同语义）。
        let policy = await resolvePolicy(meta);
        if (meta.policyOverride && policy) policy = { ...policy, mode: meta.policyOverride };
        if (policy === null) return null;                    // fail-closed
        // ★ R-v1（2026-11-04 全功能核验①）：**full-access 也不许短路 confine**。
        //   原来这里 `return { argv }` —— 理由是「没得 enforced，原 argv 交回即可」。
        //   真机实测证伪：ctx 提权 danger-full-access 获批后写 `.dsh\` 仍 EPERM，
        //   而同一次审批下 pwsh 写同一位置 OK。差别就在这条短路：
        //   DSH 的沙箱是**令牌级**的（插件宿主进程本身跑在受限令牌里，子进程一律继承），
        //   能换令牌的只有 `sandbox.confine` 交回的启动器。短路 = 直接继承受限令牌
        //   → 审批批了、权限没到。pwsh 之所以能出去，正因为它**从不短路**、每次都走 confine。
        //   所以：full-access 也要调 confine，只是把它当「无限制启动器」用。
        try {
            const confined = await sandbox.confine(argv, policy, meta?.signal);
            if (confined && Array.isArray(confined.argv) && confined.argv.length > 0) return confined;
            // confine 对 full-access 也可能返回坏形状（宿主实现不同）——
            // 已获批的 full-access 退回原 argv 不算放宽（本来就无限制），但必须留痕。
            if (policy.mode === FULL_ACCESS) {
                log('sandbox.confine 对 full-access 返回坏形状，按已获批 mode 退回原 argv');
                return { argv };
            }
            log(`sandbox.confine 返回坏形状：${confined === null ? 'null' : typeof confined}`);
            return null;                                    // fail-closed（受限档必须拒）
        }
        catch (e) {
            // 已获批的 full-access：confine 抛也不该把整次调用判死（批准本身即授权）。
            if (policy.mode === FULL_ACCESS) {
                log(`sandbox.confine 对 full-access 抛错，按已获批 mode 退回原 argv：${e?.message ?? e}`);
                return { argv };
            }
            throw e;                                         // 受限档：拒跑原样上抛 → 13-sandbox 记 DENIED_PATH
        }
    };
    confiner.describe = async (meta = {}) => {
        let policy = await resolvePolicy(meta);
        if (meta.policyOverride && policy) policy = { ...policy, mode: meta.policyOverride };
        if (policy === null) return null;
        // ★ R-v1：enforcement 仍按 mode 汇报（full-access = 不给脚本设围栏 / 全语言放行），
        //   但 **confine 一律要调** —— 它同时是「换令牌的启动器」，
        //   enforcement='none' 只表示此会话不受围栏约束，不代表子进程能继承受限令牌。
        //   注意：workspaceRoot 语义**不动**（仍取 policy 的值）——本次只修 confine 短路，
        //   围栏根的语义变更不在本次范围（改了会连带影响 file 入参判定）。
        return {
            enforcement: policy.mode === FULL_ACCESS ? 'none' : 'confined',
            workspaceRoot: policy.workspaceRoot ?? null,
            mode: policy.mode,
        };
    };
    return confiner;
}

function renderOpTable(list) {
    const rows = list.map((o) => `${o.op.padEnd(9)} ${o.required.padEnd(24)} ${o.oneLine}`);
    return ['op        required                 what', '-'.repeat(72), ...rows].join('\n');
}

/** fs/path 里文件存在但导入失败时给一条能看懂的错误（避免 ERR_MODULE_NOT_FOUND 裸奔）。 */
function pathToFileURLSafe(p) {
    return new URL(`file://${p.replace(/\\/g, '/').replace(/ /g, '%20')}`).href;
}

// ─────────────────────────────────────────────────────────
// CLI：node index.mjs --selftest
// ─────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) {
        const engine = await createEngine({ level: process.env.ENGINE_LOG ?? 'debug', tempDir: TEMP });
        const report = {
            version: '1.0.0',
            blocks: engine.blocks.map((b) => b.name),
            missingBlocks: engine.missingBlocks,
            opCount: engine.opCatalog.length,
            ops: engine.opCatalog.map((o) => o.op),
        };
        console.log(JSON.stringify(report, null, 2));
        if (argv.includes('--tool-surface')) console.log('\n' + renderOpTable(engine.opCatalog));

        // 闸①：schema 可结构化克隆（1.2.2 事故：zod 实例递给宿主 → 整轮全崩）
        JSON.parse(JSON.stringify(engine.opCatalog));
        console.log(`\n✓ 可克隆：${engine.opCatalog.length} 个 op`);

        // 闸②：17 块全就位
        const ready = engine.blocks.length === BLOCK_MANIFEST.length && engine.missingBlocks.length === 0;
        console.log(`${ready ? '✓' : '✗'} 块就绪：${engine.blocks.length} / ${BLOCK_MANIFEST.length}`);

        // 闸③：真写真搜（G1 的核心，不写库只写临时库）
        let writeSearchOk = false;
        let detail = '';
        try {
            const { assemble } = await import('./blocks/16-entry/index.js');
            const tempDir = path.join(TEMP, `g1-selftest-${process.pid}`);
            const eng = await assemble({ contentDir: tempDir, registry: engine.registry, level: 'error' });
            eng.writer.write({ content: '# 僵尸进程\nWAL 锁需要进程探活判定。', source: 'g1-doc' });
            const hits = eng.reader.search({ query: '僵尸进程', limit: 3 });
            writeSearchOk = hits.length > 0 && hits[0].content.includes('僵尸');
            detail = `写 1 源 → 搜「僵尸进程」命中 ${hits.length} 条`;
            eng.close();
            fs.rmSync(tempDir, { recursive: true, force: true });   // 跑完即删（红线 5）
        }
        catch (e) {
            detail = `${e.code ?? 'ERROR'}: ${e.message}`;
        }
        console.log(`${writeSearchOk ? '✓' : '✗'} 真写真搜：${detail}`);

        const allGreen = ready && writeSearchOk;
        console.log(`\nG1 ${allGreen ? '全绿 ✅' : '未过 ❌'} —— 17 块 / ${engine.opCatalog.length} op / 可克隆 / 真写真搜`);
        process.exitCode = allGreen ? 0 : 1;
    }
    else {
        console.log('用法：node engine/index.mjs --selftest [--tool-surface]');
        process.exit(1);
    }
}

export { TEMP };
