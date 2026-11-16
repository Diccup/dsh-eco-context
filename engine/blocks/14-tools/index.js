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
 * 14-tools — 工具面（14 个 op 的薄壳 + ctx 的真分派）
 *
 * 干什么：把 14 个 op 注册进 registry，每个 op 一个薄壳：schema 校验 → 调对应块 → 格式化回文本。
 * 为什么这样：① 工具面折叠成 1 个壳 `ctx` 后，模型看不到 13 个独立 schema，
 *              所以描述里必须自带 op 表（文案面在 descriptions/ctx.md，不在这里）；
 *            ② **真分派，不许字符串猜测**：op → registry.get(op) 拿真实条目，壳只做 entry.call(args)；
 *            ③ 每个 op 仍有自己的 selftest（折叠是工具面的事，不是块的事）。
 * 边界：**这层不许有业务逻辑**。所有写入/查询/清理都调 08/09/11/12/13。壳只做参数规整 + 错误包装。
 */

import { err, describe } from '../../libs/err.js';
import { capBytes, selectChunks, moreLine } from '../../libs/select.js';
// ★ 2026-11-09 ④步 CTX 净身：`assertSafeUrl` import **退役**（净身版 §三-2）。
//   它原来只服务两处，两处都已随 search 迁 FP：
//     · op:search 的 url 腿（reg('search') 整段已移除）
//     · index{url} 分支（已整段移除）
//   ⇒ CTX 侧本文件对 url-guard 零引用。**`engine/libs/url-guard.js` 本体留守不删**
//   （v2.2 §一-4 双留口径：FP 拿一份，CTX 原件不动），呈"0 引用死代码待复活引回"状态，
//   属设计内，不当残留清理（见净身版 §三-2 括注、§二 落点表"两边各留一份"）。
import { buildSnippet, snippetTerms, SNIPPET_MAX_BYTES } from '../../libs/snippet.js';

export const NAME = 'tools';
export const INVARIANTS = [
    '壳里不许 switch 复制业务：op 一律真分派到 registry',
    '每个 op 的返回都带可读文本（模型看不到结构化对象）',
    '所有错误走 libs/err.js，第一行是"怎么改"',
    'ctx 描述 ≤1563B（≈300 token）且自带 op 表；文案在 descriptions/ctx.md，本文件只是加载器',
    'ctx.md 里每个 op 必须有行、registry 里每个 op 必须被 ctx.md 声明 —— 缺一个装配就抛',
];

/**
 * ctx 壳的工具描述 —— **文案面在 `descriptions/ctx.md`，这里只是加载器**。
 *
 * ★ 2026-11-04 设计确定：（仿 2.0 `src/prompt/tools/<tool>.md`，02-清单 §3.1 文案面整合的落地）：
 *   「描述搬出代码进 .md（改文案不碰源码），并按 2.0 形态倒序写（Example→Required→是什么→细节）」。
 *   改一行文案 = 改 ctx.md，零语法风险、不用重跑编译；
 *   代价（任务书已写清）：启动多一次文件读取 —— 一次性、几 KB，可忽略。
 *
 * 两条硬规矩（防"文案与运行面漂移"，同族缺陷的老账）：
 *   ① ctx.md 缺文件 → 启动直接抛（不许静默退回 JS 常量 —— 那等于文案面失联还没人知道）
 *   ② createTools() 里逐个 op 校验：ctx.md 的表里必须有这一行，缺 → 装配抛
 *      （G11③ 在门里扫的是成品，这条在运行时守的是每一次真装配）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DESCRIPTION_FILE = fileURLToPath(new URL('./descriptions/ctx.md', import.meta.url));

/**
 * ctx.md 体积红线：**1563 B ≈ 300 token**。
 *
 * ★ 2026-11-05 设计确定：从 1200 B 抬到 1563 B。
 *   为什么抬：1200 B ≈ 223 token 装不下「首句简介 + 14 op 行 + 易错点/示例」，
 *   而模型真正会踩的坑（`见 allowed` 这种指路、`queries` 到底是不是数组、
 *   `临时→长久` 是库还是状态）必须写进描述 —— 藏进 SKILL 等于没写。
 *   抬到 300 token 后实测 1381 B ≈ 265 token，还能再放一条易错点。
 *
 * ★ 为什么用 token 反推字节而不是直接数字节：模型侧计费与上下文占用都是 token，
 *   字节只是落地单位。实测换算 1162 B / 223 token ≈ **5.21 B/token**（中英混排），
 *   300 token × 5.21 ≈ 1563 B。中文占比变化会让真实 token 浮动 ±10%，
 *   所以这个数取的是"300 token 的保守上限"，不是精确等号。
 *
 * 边界：**改这个值 = 改工具描述预算**，等于改每轮请求的常驻开销 —— 要问维护方。
 */
export const DESC_MAX_BYTES = 1563;

/**
 * ~~search 返回条数的开区间 1..30（维护方 2026-11-07 定）~~
 *
 * ★ 2026-11-09 ④步 CTX 净身：**整段退役**（`SEARCH_LIMIT_DEFAULT`/`SEARCH_LIMIT_MAX`/
 *   `clampSearchLimit` 一并移除，净身版 §三-2 的连带执行）。
 *   它只服务 op:search 的 `limit` 闸，该 op 已整条迁 FP ⇒ 留在 CTX 就是"最纯的死代码"，
 *   而且留着会让"CTX 不含 SEARCH"这句话在源码层面自相矛盾（§三-23 拆干净机检会把它算成残留）。
 *   **FP 侧必须重建这三件**（默认 10 / 上限 30 / 非数字回默认），当时的实测理由一并带过去：
 *   14 个查询下 10 条正好覆盖 7.29 家引擎，第 11 条起新增引擎覆盖 = 0%；
 *   上限 30 因交付体积实测 6.5–7.9 KB、离 40 KB containment 还有 32 KB 余量，且不增加抓取成本
 *   （bing 硬顶 10、baidu 11、其余 8–10，超了只是空转）。闸要装在"模型能碰到的入口"手边。
 */

/** 读文案文件；缺/空/超红线都直接抛（宁可装不上，也不挂一份坏文案）。 */
export function loadDescription(file = DESCRIPTION_FILE) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(`14-tools: 文案文件读不到 ${file} —— ${e.message}`);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error(`14-tools: 文案文件是空的：${file}`);
    const bytes = Buffer.byteLength(trimmed, 'utf8');
    if (bytes > DESC_MAX_BYTES) throw new Error(`14-tools: ctx.md ${bytes} B > ${DESC_MAX_BYTES} B（折叠后模型只看得到这一个壳，描述红线 ≈300 token）`);
    return trimmed;
}

/** ctx.md 表里声明的 op 行（与 G11③ 同一条解析路：`^[a-z]+ 空格/—`，滤掉表头与首句）。 */
export function opsDeclaredIn(text) {
    return [...text.matchAll(/^([a-z]+)\s+(\S|—)/gm)]
        .map((m) => m[1])
        .filter((n) => n !== 'op' && n !== 'ctx');
}

/** 装配时加载一次；selftest / 门可再单独 import loadDescription 直接测文件。 */
export const CTX_RUN_DESCRIPTION = loadDescription();

/**
 * @param {object} deps 由 16-entry 装配好后注入
 * @param {object} deps.registry
 * @param {object} deps.writer
 * @param {object} deps.reader
 * @param {object} deps.memory
 * @param {object} deps.recall
 * @param {object} deps.lifecycle
 * @param {object} deps.sandbox
 * @param {object} [deps.web]      网页搜索（★ 2026-11-09 净身：CTX 侧已无消费方 ——
 *                                 op:search 与 index{url} 双入口全迁 FP，本块不再读 deps.web。
 *                                 保留此注记仅为说明接缝历史；FP 侧按自己的落点重建注入链）
 * @param {object} [deps.purger]   显式清除（12-lifecycle 的 purge 部分）
 * @param {object} [deps.toolSwitch] 工具开关（platform/tool-switch.js 注入；缺失时 op=switch 给可读错误）
 * @param {(() => object)|null} [deps.hintState]
 *        ★ 2026-11-06 S9.44：道 A 的**真实**遥测口。
 *        道 A 生产实现在 `ours/recall-hints.js`（挂宿主 `tools/pre-execute`，
 *        由 platform 注入 `consumeHint`），而本引擎的 `10-recall.recallHints`
 *        在生产上**零调用方**（只有 15-hooks 与它自己的 selftest 用）。
 *        所以 `op:stats` 原来读 `deps.recall._state()` 报的 `seenA` **恒为 0** ——
 *        那一行数是死的（PENDING「op:stats 的 hints 读错池」）。
 *        平台层把 ours 那个 `hintState()` 从这里递进来就成了真数；
 *        引擎独立跑（无平台层）时为 null → 回退旧行为，不改既有语义。
 */
export function createTools(deps) {
    const { registry } = deps;
    if (!registry) throw new Error('14-tools: 缺 registry');

    const ops = new Map();

    /** 注册一个 op：handler 只做"参数规整 + 调块 + 渲染文本"。 */
    function reg(op, { required = '', oneLine, call }) {
        ops.set(op, { op, required, oneLine, call });
        // ★ 2026-11-06 S9.36：原来填 `ctx_${op}` —— 那是**旧工具位名**
        //   （ctx_search / ctx_recall / ctx_index …），2026-11-04 折叠后这些位已经不存在，
        //   现在只有一个工具位 `ctx`，op 靠 `op` 参数分派。
        //   旧名会随 registry.toolList() → api.opCatalog 序列化出去 = 对外报不存在的工具位。
        //   现在统一填现行位名 `ctx`。
        try { registry.registerTool(op, { name: 'ctx', required, oneLine, call }); }
        catch (e) {
            if (!/重复/.test(e.message)) throw e;
        }
    }

    /** 文本渲染：把结果压成模型能读的紧凑文本（结构化对象另行放在 result）。 */
    function render(value) {
        if (value === undefined || value === null) return '(无输出)';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            if (value.length === 0) return '(0 命中)';
            return value.map((r, i) => {
                if (r && typeof r === 'object' && 'title' in r && 'source' in r) {
                    const tag = r.store === 'memory' ? '[长久] ' : '';
                    const hl = r.highlighted ? '\n' + String(r.highlighted).replace(/\u0002/g, '**').replace(/\u0003/g, '**') : '';
                    return `${i + 1}. ${tag}${r.title}  (${r.source})${hl}`;
                }
                return `${i + 1}. ${typeof r === 'string' ? r : JSON.stringify(r)}`;
            }).join('\n');
        }
        return JSON.stringify(value, null, 1);
    }

    // ── run：执行面（★ P3 沙箱归一：guard 的能力全在这归位，桥侧不再碰执行）──
    //
    // 收敛原则（2.0 D-M2-6「no cut without index」）：超预算的输出**先整份入库，
    // 再按 intent 选整块**回文本 —— 截断只在库不可用时兜底，绝不静默丢内容。
    // 阈值与 guard 时代对齐（维护方 2026-11-02 定 5KB）：>5KB 就值得一次 index+recall 换省上下文。
    const INTENT_INDEX_BYTES = 5_000;
    const RUN_OUTPUT_BUDGET_BYTES = 16_384; // 回给模型的正文预算（= MAX_OUTPUT_BYTES）

    /**
     * ★ 2026-11-12（设计确定：案）：`recall{full:true}` 的正文预算 = **40 KB**。
     *
     * 为什么有这个常量：`run` 超 5KB 的提示一直写着「取回：ctx({op:"recall",…})」，
     * 而 2026-11-04 乙档重写把 recall 改成 `buildSnippet` 窗口化（800 B/块）之后，
     * **提示承诺全文、实现只给两成，且不说被切了** —— 话术和实现对不上。
     * 现在补一条显式全文旁路：默认仍窗口化（省上下文），`full:true` 整块拼回。
     *
     * ★★ 2026-11-12 第二次定案（说明：「把64KB改成40KB更好，再多内容就应该去读文件了」）。
     *   病根是**两层阈值打架**：本常量原设 65,536，而平台层 `ours/output-containment.js`
     *   的 `DEFAULT_MAX_RESULT_BYTES = 40_000` 会把**整个工具返回文本**砍成头 6000 + 尾 2000。
     *   实测 64,786 B 的源用 `full:true` → 回文 65,324 B > 40,000 ⇒ **中间 57,314 字符被砍**。
     *   也就是说 64KB 那个预算**是白调的**：外层 40KB 先动手，`full:true` 说得出做不到 ——
     *   比不承诺更坏。
     *
     *   现在把内层预算压到**与外层同口径的 40,000**，语义变成：
     *   **「一次最多给你 40KB，再多就去读文件」** —— 说得到，也做得到。
     *
     *   为什么不抬外层：`output-containment` 是**所有工具**的全局护栏，为 recall 一家抬它
     *   等于给所有工具放水。压内层不动全局，是正确的一侧。
     */
    const RECALL_FULL_BUDGET_BYTES = 40_000;

    /**
     * ★ 2026-11-12：`full:true` 的**包装余量**。
     *
     * 为什么要从预算里扣：`RECALL_FULL_BUDGET_BYTES` 守的是"整个返回文本 ≤ 外层 40KB"，
     * 而返回文本 = 标题行 + 各块正文 + 块间分隔 + 末尾提示行。
     * 只按正文算预算（正文正好 40,000）⇒ 加完标题就 40,001 ⇒ **外层照样砍**。
     *
     * 1024 B 的来历：标题 `## <label>（全文 N 块 / X B）` ≤ 128 B、
     * 末尾提示 ≤ 512 B、块间 `\n\n` ≤ 2×块数。留 1KB 足够且不浪费多少正文。
     */
    const RECALL_FULL_WRAPPER_RESERVE_BYTES = 1_024;

    /**
     * ★ 2026-11-12：预算的**人类可读标签**，四处文案共用这一个口。
     *
     * 为什么不用 `Math.round(BYTES / 1024)`：40,000 B ÷ 1024 = 39.06 ⇒ 四舍五入印成
     * **"39KB"** —— 而本常量、`output-containment` 的 `DEFAULT_MAX_RESULT_BYTES = 40_000`
     * 以及维护方嘴里的说法全是 **"40KB"**（十进制口径）。印 39 会让"我到底能不能给 40KB"
     * 变成一个假问题。用 `Math.ceil` 对齐十进制叫法，并在文案里带上精确字节数兜底。
     */
    const RECALL_FULL_BUDGET_LABEL = `${Math.ceil(RECALL_FULL_BUDGET_BYTES / 1024)}KB`;

    /**
     * ★ 2026-11-12：`full:true` 去重叠时**最多剥几行**。
     *
     * 来历：`05-analyze.chunkPlainText` 的 `overlap = 2`（相邻块共享 2 行）。
     * 所以实际要剥的就是 2 行。留到 8 是给将来 overlap 调大留余量，
     * 同时当"两块内容高度相似"时防止一路剥光。
     *
     * ★ 与 `overlap = 2` 的联动：如果哪天 `05-analyze` 改了 `overlap`，
     *   这个数**必须同步**（改大了会剥不干净，改小了无影响只会少剥）。
     *   关联点已记入 `Updating\模块关联表.md` §三「片段可见性」组。
     */
    const CHUNK_OVERLAP_MAX_LINES = 8;

    /** 给本次执行的输出起一个独立可寻址的 source 标签（同 guard 的 label 语义：前缀可族筛）。
     *  ★ S9.48（2026-11-07）：语言段**必须是这次真跑的语言**。
     *    原来硬写 `run:javascript:`，与实参无关 —— 实测库里带 `shell-resolution` 字样的 6 块
     *    全挂在 `run:javascript:` 下（那 6 次明明是 shell）。于是"run: 源全是 javascript"
     *    这份统计是假的，差点被当成"javascript 更常用"的证据。
     *    ★ 只改标签名字：执行路径、排序、任何判据都不动。
     *    ★ 旧数据不改（历史标签就那样），新写入立刻对得上。 */
    function execLabel(language) {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const lang = typeof language === 'string' && language.length > 0 ? language : 'javascript';
        return `run:${lang}:${stamp}-${Math.random().toString(16).slice(2, 8)}`;
    }

    /** queries 宽容接收（2026-11-04 真机抓到）：宿主把数组参数原样透传没问题，
     *   但调用方（模型）常写成单个字符串或 JSON 字符串。三种都认，绝不再报 NO_QUERY。 */
    function normalizeQueries(value) {
        if (Array.isArray(value)) return value.filter(Boolean).join(' ').trim();
        if (typeof value !== 'string') return '';
        const s = value.trim();
        if (s.startsWith('[')) {
            try { return normalizeQueries(JSON.parse(s)); } catch { /* 不是合法 JSON 就当正文 */ }
        }
        return s;
    }

    /**
     * ★ queries 宽容接收 —— **返回数组**（乙档：每问一节，不许 join 成一串）。
     *
     * 为什么必须返回数组（2026-11-04 乙档）：
     *   旧 `normalizeQueries` 把 `["结论","约束"]` join(' ') 成 `"结论 约束"`，
     *   一次查询 = AND 语义 → 两问的命中被**互相收窄**（实测 38 块 vs 并集 100 块）。
     *   2.0 的做法（`core/tools/search.ts` relevance）：`queries` 数组逐个查，
     *   每问一节，节与节之间**不互相收窄**。
     *
     * 三种形态全认（真机教训：数组到引擎可能变形）：
     *   · 真数组            → 逐项保留（去空、去重）
     *   · JSON 数组字符串   → 解析后同上
     *   · 单个字符串        → **按空格切成多问**？不 —— 单个字符串是一个查询，
     *     内部空格是**词边界**（"WAL checkpoint" 是一个两词查询，不是两个查询）。
     *   · `query` 单数形式  → 当作一问
     * @param {unknown} queries
     * @param {unknown} query 单数兼容
     * @returns {string[]} 查询列表（≥1 项；全空则 [])
     */
    function normalizeQueryList(queries, query) {
        const out = [];
        const push = (v) => {
            const s = String(v ?? '').trim();
            if (s.length > 0 && !out.includes(s)) out.push(s);
        };
        if (Array.isArray(queries)) {
            for (const q of queries) push(q);
        }
        else if (typeof queries === 'string') {
            const s = queries.trim();
            if (s.startsWith('[')) {
                try {
                    const parsed = JSON.parse(s);
                    if (Array.isArray(parsed)) for (const q of parsed) push(q);
                    else push(s);
                }
                catch { push(s); }   // 不是合法 JSON 就当正文（一问）
            }
            else {
                push(s);
            }
        }
        else if (queries !== undefined && queries !== null) {
            push(queries);
        }
        // `query` 单数：只有 queries 完全没给时才用（两处都给 → queries 优先）
        if (out.length === 0 && typeof query === 'string') push(query);
        return out;
    }

    /**
     * ★★ C-1 / A-10（2026-11-09 ④步 CTX 净身）：**数组参数的宽容解析**（三认）。
     *
     * 依据 = 净身版 §一 C-1：**N-①：宿主→工具面参数送达变形，属宿主段、拆插件治不了，
     * CTX 与 FP 各自必修**。先例 = `normalizeQueryList`（queries[] 已三认）。
     * 本条补的是**其余数组参数**——`commands[]` 是唯一还没被宽容层覆盖的数组入口。
     *
     * 真机病根（与 queries 同族，2026-11-04 抓过一次、A-10 又点了一次）：
     * 宿主把数组原样透传时没问题，但调用方常写成
     *   · JSON 串   `commands: '["dir","echo hi"]'`   → `Array.isArray` 假 ⇒ 掉进 NO_INPUT
     *   · 单条串    `commands: 'dir'`                 → 同上，明明只跑一条却报"缺参"
     * 两种都不是"参数错了"，是**同一件事的另一种写法**。判据必须认三种形态，
     * 否则模型会反复重试同一个调用（它不知道自己写法"其实没错"）。
     *
     * 三认规则（与 normalizeQueryList 同构，保持一致口径）：
     *   · 真数组          → 逐项保留
     *   · JSON 数组字符串 → 解析后同上（解析失败**不**降级成单条，见下）
     *   · 单个字符串      → 包成一项（单条命令是合法的"一批只有一条"）
     *   · 其余/空         → `undefined`（= 没给，交给上层报缺参）
     *
     * ★ 故意**不**做的事：JSON 解析失败时**不**把它当一条命令。
     *   理由：`commands:'["a","b"'`（少个括号）当单条执行，会变成跑一条叫
     *   `["a","b"` 的命令 —— 静默执行一段错命令，比报错更坏（同族教训：
     *   "写完才抛错的半成功"、"静默走错分支的假开关"）。宁可让它落空后被报缺参。
     *
     * @param {unknown} raw
     * @returns {string[]|undefined} 认出来就给数组，认不出给 undefined
     */
    function normalizeStringList(raw) {
        if (Array.isArray(raw)) {
            return raw.length > 0 ? raw : undefined;
        }
        if (typeof raw !== 'string') return undefined;
        const s = raw.trim();
        if (s.length === 0) return undefined;
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                // 解析成功但元素不是数组（如 '["a"]' 之外给个 '[1]'）→ 仍交给形状闸去拒，
                // 这里只负责"还原成数组"，**不**替形状闸做判据（职责分离：宽容 vs 校验）。
                if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : undefined;
            }
            catch { return undefined; }   // 见上：坏 JSON 不许降级成单条命令
            return undefined;
        }
        // 单个字符串 = 一批里只有一条
        return [s];
    }

    reg('run', {
        required: 'language|code|file|commands',
        oneLine: '跑代码/命令/批量（12 语言）',
        async call(args, runtime) {
            const sb = deps.sandbox;
            if (!sb) throw new Error('14-tools: 13-sandbox 未装配');
            const { language = 'javascript', code, file, commands: rawCommands, timeoutMs, background, intent, cwd, env } = args ?? {};
            // ★ C-1 / A-10：先把 commands 用宽容层规整（数组 / JSON 串 / 单串三认），
            //   后面一律用规整后的 commands；`rawCommands` 只在这里出现一次。
            //   注意：宽容层不认识的值给 undefined ⇒ 行为与"没给 commands"完全一致（落到缺参报错），
            //   所以这条改动**不会**把原来该报错的输入变成静默执行。
            const commands = normalizeStringList(rawCommands);
            const rt = {
                signal: runtime?.signal,
                session: runtime?.session,
                policyOverride: runtime?.policyOverride,
                // ★ R17（2026-11-05）：`agent` 是后台作业的归属（owner），必须传到 13-sandbox。
                //   断了它 → jobHost.start 拿不到 owner → 宿主按"无归属作业"处理，
                //   模型收不到完成通知（作业还在跑，但没人认领）。
                agent: runtime?.agent,
            };

            // 报错分型（guard 四年实撞的"为什么这条路走不通"，一律 NO_INPUT 会让模型反复重试）
            if (Array.isArray(commands) && commands.length > 0) {
                if (code !== undefined && String(code).trim().length > 0)
                    throw err('ONE_OF_INPUT', { given: ['code', 'commands'] });
                // ★ 2026-11-06 S9.36：commands 的**形状**闸（缺的另算，缺参在上面）。
                //   真机踩坑：传嵌套数组 [["a","b"]] 时 Array.isArray + length 都过，
                //   于是进 runBatch → 每条是数组 → String(cmd) 拍成 "a,b" → 行为不明确且不报错。
                //   现在在这里就拒，并把**能直接抄的正确格式**写进第一行。
                const badIdx = commands.findIndex((c) => typeof c !== 'string');
                if (badIdx !== -1) {
                    throw err('BAD_BATCH_SHAPE', {
                        index: badIdx,
                        got: Array.isArray(commands[badIdx]) ? 'array' : typeof commands[badIdx],
                        reason: `commands 第 ${badIdx + 1} 条不是字符串 —— commands 要扁平字符串数组：每条一个字符串，如 ["dir", "echo hi"]；不许嵌套数组（[["a","b"]] 会被拍成 "a,b"），也不许传对象`,
                    });
                }
                // ★ R8（2026-11-04 测试汇总）：runBatch 现在**会抛**（受限起跑前拒 / 整体失败）。
                //   这里不许再兜底渲染 —— 抛上去就是模型能读到的失败。
                const r = await sb.runBatch({ commands, timeoutMs, ...rt });
                // 部分失败：把失败条数写进文本，别让"3 条里 2 条死了"看着像全绿。
                const bad = Array.isArray(r?.settled)
                    ? r.settled.filter((s) => s?.status === 'rejected' || (s?.value && s.value.ok === false))
                    : [];
                const head = bad.length > 0 ? `（${bad.length}/${commands.length} 条失败）\n` : '';
                const first = bad[0];
                const why = first?.status === 'rejected'
                    ? (first.reason?.message ?? String(first.reason))
                    : (first?.value?.message ?? '');
                return {
                    result: r,
                    text: head + render(r) + (bad.length > 0 && why ? `\n首条失败：${String(why).split('\n')[0]}` : ''),
                };
            }
            if (file !== undefined && (code === undefined || String(code).trim().length === 0)) {
                throw err('NO_INPUT', { reason: 'file 只负责把绝对路径塞进 CTX_FILE，脚本正文仍要走 code —— 正确写法 {op:"run", file:"<路径>", code:"…读 process.env.CTX_FILE…"}；只想读文件内容就直接 code 里用 fs 读' });
            }
            if (code === undefined || String(code).trim().length === 0) {
                // ★ 2026-11-06 S9.36：原文案写的是 "exec 需要 code…" ——
                //   「exec」是 op 改名之前的老称（2026-11-04 定「工具面只剩 1 位 ctx」，
                //   op 名 exec → run），文案没跟着改 ⇒ 报出来仍是在用旧名指路。
                //   同时按维护方二问「报错要直接给正确格式」：第一行给**能直接抄的示例**。
                throw err('NO_INPUT', {
                    reason: 'run 需要 code（脚本正文）或 commands（批量）：正确写法 {op:"run", language:"javascript", code:"console.log(1)"}；批量 {op:"run", commands:["dir","echo hi"]}（扁平字符串数组）；code 与 commands 互斥，只给一个；file 只给路径、正文仍走 code',
                });
            }

            const out = await sb.run({ language, code, file, timeoutMs, background, cwd, env, maxOutputBytes: Number.MAX_SAFE_INTEGER, ...rt });
            // 结构化失败（ok:false）：13-sandbox 给的是带 code/fix 的失败形状
            // ★ R16（2026-11-05 需求方要求）：message 与 fix 内容不同，拼接要**去掉空段**，
            //   否则 message 为空时会渲染出一个开头空行（旧版 message/fix 重复填同一段，更是三遍）。
            if (out.ok === false) {
                const parts = [String(out.message ?? '').trim(), String(out.fix ?? '').trim()].filter((s) => s.length > 0);
                throw Object.assign(new Error(parts.length > 0 ? parts.join('\n') : (out.code ?? 'SANDBOX_ERROR')), { code: out.code ?? 'SANDBOX_ERROR' });
            }
            // ★ R17（2026-11-05）：后台作业的返回**必须第一个判**。
            //   否则它落到下面按 exit/stdout 渲染的正常分支（exit=0、body 为空）→
            //   模型只看到 "(exit=0)"，作业 id 彻底丢失 —— 作业在跑但没人收得回来，
            //   比不给后台更糟（占着并发名额、输出没人读、模型以为跑完了）。
            if (out.backgrounded === true && typeof out.jobId === 'string') {
                return {
                    result: out,
                    text: `后台作业已开：job_id = ${out.jobId}\n`
                        + `用 job_output(id="${out.jobId}") 收输出，job_list 看状态，job_kill 停它。\n`
                        + `（本 op 立刻返回，不占上下文；作业归属本会话，会话结束自动清理。）`,
                };
            }
            const body = [out.stdout, out.stderr].map((t) => String(t ?? '').trimEnd()).filter((t) => t.length > 0).join('\n');
            const head = `(exit=${out.exitCode}${out.timedOut ? ' timedOut' : ''}${out.truncated ? ' truncated' : ''})`;
            if (body.length === 0) return { result: out, text: head };
            const bytes = Buffer.byteLength(body, 'utf8');

            // ★ 阈值语义（维护方 2026-11-02 定案，guard 侧同款）：**超 ~5KB 就不许拿原文进对话** ——
            //   整份入库，回定位符（有 intent 就替他选好块）。16KB 只是"给模型的正文"预算上限，
            //   不是"要不要入库"的门槛；把两者混了就是这次⑯红的根因，记在这防重踩。
            if (bytes <= INTENT_INDEX_BYTES) {
                return { result: out, text: `${head}\n${body}` };
            }

            // 超限：先整份入库（writer 在才收这条路；独立跑没库 → 截断兜底并说清楚）
            const w = deps.writer;
            if (!w) {
                const capped = capBytes(body, RUN_OUTPUT_BUDGET_BYTES);
                return {
                    result: out,
                    text: `${head}\n${capped.text}\n…（无库可入，硬截到 ${RUN_OUTPUT_BUDGET_BYTES} B；全文 ${bytes} B 已丢 —— DSH 侧装配后这条会变成入库+定位符）`,
                };
            }
            const label = execLabel(language);
            // CJK 分词不归这里：07-tokenize/gram 通道在写入侧已经管中文（cjkAdapt 退役同因）。
            w.write({ content: body, source: label, kind: 'plain' });
            const kb = (bytes / 1024).toFixed(1);

            if (typeof intent === 'string' && intent.trim().length > 0 && deps.reader) {
                // intent 选块：整块、按分数、预算内（2.0 selectChunks 语义）
                const rows = deps.reader.search({ query: intent.trim(), source: label, limit: 20 });
                const picked = selectChunks(rows, RUN_OUTPUT_BUDGET_BYTES);
                const lines = [
                    head,
                    `Intent containment: 输出 ${kb}KB > ${Math.round(INTENT_INDEX_BYTES / 1024)}KB，已整份入库 source "${label}"（${body.split('\n').length} 行不进对话）。`,
                ];
                if (picked.picked === 0 || rows.length === 0) {
                    lines.push(`没有块匹配 intent "${intent.trim()}"。`, '',
                        `换词再取：ctx({op:"recall",queries:[…],source:"${label}"})`,
                        `要全文：同一条加 full:true（最多 ${RECALL_FULL_BUDGET_LABEL}）`);
                }
                else {
                    lines.push(picked.text);
                    if (picked.hidden > 0) lines.push('', moreLine(intent.trim(), label, picked.hidden));
                }
                return { result: out, text: capBytes(lines.join('\n'), RUN_OUTPUT_BUDGET_BYTES + 2048).text };
            }

            // 无 intent 的超限：回定位符（guard 的 storeLargeOutput 同款）
            // ★ 2026-11-12（设计确定：案）：文案改说真话。
            //   原来只写「取回：ctx({op:"recall",…})」—— 而乙档窗口化之后，照这句
            //   去取只拿到 800 B/块（实测 12 KB 的源只回 2.4 KB）且不说是片段。
            //   现在两条路都写清楚：默认窗口（省上下文）/ full:true（真全文）。
            return {
                result: out,
                text: [
                    head,
                    `输出 ${kb}KB 超过 ${Math.round(INTENT_INDEX_BYTES / 1024)}KB 阈值：已整份入库 source "${label}"（${body.split('\n').length} 行不进对话）。`,
                    '',
                    `取回片段：ctx({op:"recall",queries:[具体词],source:"${label}"})`,
                    `取回全文：同一条加 full:true（最多 ${RECALL_FULL_BUDGET_LABEL}）`,
                    `带 intent 重跑本命令可由引擎直接选好块。`,
                ].join('\n'),
            };
        },
    });

    // ── search：网页 ──
    //
    // ★ 2026-11-09 ④步 CTX 净身：`reg('search')` **整段移除**（14 → 13 op）。
    //   迁出去的东西（一条不许丢，全在 FP 侧重建）：query 聚合腿、url/page 抓正文腿、
    //   media 腿、engines 白名单、clampSearchLimit(默认10/上限30) 闸、SSRF 入口闸
    //   `assertSafeUrl`、`WEB_NOT_MOUNTED` 错误面、`render(r?.results ?? r)` 交付形态。
    //   维护方 13:2x：「FP就是搬出去的OP SEARCH」；13:5x：「CTX不包含SEARCH」。
    //   史见净身版 §三-1、§二 落点表（A-1/A-3/A-5/A-7a/A-9/N12 全套 → FP）。
    //   注意：`assertSafeUrl` 的 import 仍在 —— 它还给下面的 index{path/content/dir} 之外
    //   留了零引用？→ 不，本轮已同步摘掉 import（见文件头）。url-guard.js 本体**留守不删**
    //   （v2.2 §一-4 双留口径：CTX 原件不动，FP 拿一份），CTX 侧呈"0 引用死代码待复活引回"。

    // ── recall：本地库召回（原 ctx_recall 工具位，2026-11-04 并入壳 op）──
    //
    // ★ 2026-11-04 乙档重写（抄 2.0 `core/tools/search.ts` 的 relevance 路径）：
    //   ① **每问一节、命中取并集** —— 旧写法 `normalizeQueries` 把数组 join(' ') 成一串，
    //      一次 AND 查询 → 多词查询召回掉一半（实测只剩 OR 语义的 45%）。
    //      2.0 的做法：queries 数组逐个查，每问一节，节与节之间**不互相收窄**。
    //   ② **窗口化回文本** —— 旧写法把 FTS5 的 highlight 全量塞回模型（单条 4,090 B）。
    //      现在按 2.0 `store/snippet.ts` 切窗口（≤ SNIPPET_MAX_BYTES/条）。
    //   ③ **长久库席位制**（S-5）—— 长久库 ≤2 席先占，临时库随后（mergeWithMemory 写过没人调）。
    reg('recall', {
        required: 'queries(2-4 词)',
        oneLine: '本地库召回（三榜 RRF，命中续命；full:true 取全文）',
        async call(args) {
            const rd = deps.reader;
            if (!rd) throw err('NO_INPUT', { reason: 'recall 需要 reader（引擎未装配时先 op=index 写入）' });
            const queryList = normalizeQueryList(args?.queries, args?.query);
            if (queryList.length === 0) throw err('NO_QUERY');
            const limit = args?.limit ?? 3;
            const offset = numOr(args?.offset) ?? 0;
            const source = args?.source;
            const contentType = args?.contentType;
            const sessionId = args?.sessionId ?? args?.session ?? '';
            // ★ 2026-11-12：全文旁路。`full:true` = 要整块原文，不要 800 B 窗口。
            const wantFull = wantsTrue(args?.full);

            // ═══ 全文旁路（维护方 2026-11-12 定案）═══
            //   默认走窗口化（省上下文，见下方 ②）；给 full:true 才整块拼回。
            //
            //   为什么做成"旁路"而不是"把窗口调大"：窗口化的立意（2.0 ADR-0016）是
            //   **召回只给够用的片段**，把默认值调大等于每个日常召回都烧上下文。
            //   而"我确实要全文"是个明确的、低频的意图 —— 它该由调用方显式说出口，
            //   引擎照着办，并把体积代价如实报出来（哪些块没放下、怎么接着取）。
            //
            //   两条取全文的路径，优先级从强到弱：
            //     ① 给了**精确命中的 source** → 走 getChunksBySource，按 rowid 顺序
            //        把该源的全部块原样拼回。这是**真全文**（连窗口切掉的中段都在），
            //        也是 `run` 超 5KB 提示里那个 source 标签所指向的东西。
            //     ② 没给 source / 给的是模糊匹配 → 退回 search 命中的块，整块不切窗口。
            if (wantFull) {
                return fullRecall({ rd, queryList, source, contentType, sessionId, limit, offset });
            }

            // ① 逐问查（每问独立，不互相收窄）
            const sections = [];
            const seenHit = new Set();
            const touchedSources = new Set();
            const allHits = [];
            let anyHit = false;
            for (const q of queryList) {
                const hits = rd.search({
                    query: q, limit, source, contentType, offset, sessionId,
                });
                if (hits.length === 0) {
                    sections.push(`## ${q}\n(0 命中)`);
                    continue;
                }
                anyHit = true;
                const lines = [];
                for (const h of hits) {
                    const key = `${h.source}::${h.title}`;
                    touchedSources.add(h.source);
                    allHits.push(h);
                    if (seenHit.has(key)) continue;   // 同一块在多问里只出现一次
                    seenHit.add(key);
                    // ② 窗口化：正文按命中位置切一段连续原文（≤ SNIPPET_MAX_BYTES）
                    const fullText = String(h.content ?? '');
                    const snippetText = buildSnippet(
                        fullText,
                        snippetTerms(String(q).toLowerCase().split(/\s+/).filter((w) => w.length > 0)),
                        SNIPPET_MAX_BYTES,
                    );
                    lines.push(`### ${h.title}  (${h.source})\n${snippetText}${windowMark(fullText, snippetText)}`);
                }
                sections.push(`## ${q}\n${lines.join('\n\n')}`);
            }
            if (!anyHit) {
                return { result: { hits: [], sections }, text: sections.join('\n\n---\n\n') };
            }

            // 续命（每日节流）：只对真正返回的 source
            try { rd.touchAccessed([...touchedSources]); } catch { /* 静默 */ }

            // ③ 长久库席位制（S-5）：长久库 ≤2 席先占，临时库随后
            const memRows = deps.memory ? deps.memory.list({ limit: 50 }) : [];
            const merged = deps.recall
                ? deps.recall.mergeWithMemory(allHits, memRows, { memorySeats: 2 })
                : allHits;
            const memSlots = merged.filter((r) => r.store === 'memory');
            if (memSlots.length > 0) {
                const memText = memSlots
                    .map((m) => `### [长久] ${m.title}  (${m.category})\n${String(m.content ?? '').slice(0, SNIPPET_MAX_BYTES)}`)
                    .join('\n\n');
                sections.push(`## 长久库\n${memText}`);
            }

            const text = sections.join('\n\n---\n\n');
            return { result: { hits: merged, sections, bytes: Buffer.byteLength(text, 'utf8') }, text };
        },
    });

    /**
     * 把一个已写入临时库的 label 钉进长久库（`op:index {pin:true}` 走这条路）。
     * @param {string} label 临时库 label
     * @param {string} category 路径制分类（11-memory 校验）
     * @returns {object|null} pin 结果；label 不在临时库 → 抛错
     */
    function pinSource(label, category) {
        const m = deps.memory; const rd = deps.reader;
        if (!m || !rd) throw new Error('14-tools: 需要 memory + reader');
        if (!label) throw err('NO_INPUT', { reason: 'pin 需要 label' });
        if (!category) throw err('NO_SCHEMA_PIN');
        const sourceId = rd.getSourceIdByLabel(label);
        if (sourceId == null) throw err('NO_INPUT', { reason: `临时库没有 label=${label}` });
        const chunks = rd.getChunksBySource(sourceId);
        if (chunks.length === 0) throw err('NO_INPUT', { reason: `label=${label} 在临时库没有块` });
        return m.pin({ label, category, chunks, title: chunks[0].title });
    }

    /**
     * `pin` 的宽容判定（R6）。
     * 真机实测：调用方常写成字符串 `pin:"true"`（带引号），严格 `=== true` 会**静默跳过钉**
     * —— 不报错、不入库，模型以为钉住了。这不是"宿主把布尔字符串化"（那条已被证伪），
     * 是调用侧写法问题；引擎这边认下两种写法，别让一个引号把数据弄丢。
     */
    function wantsPin(v) {
        return v === true || v === 'true' || v === 1;
    }

    /**
     * ★ S9.40（2026-11-06）：**布尔判据的宽容认法**（照 R6 `pin:"true"` 已验证的路子）。
     *
     * 为什么需要：调用方送来的布尔值可能已经是字符串。
     * 实测（活槽真机）：`ctx({op:"maint",action:"plan",days:3650})` 引擎收到的是 `"3650"`、
     * `days:false` 收到的是 `"false"` —— 没在工具定义里声明 `type` 的参数就是按字符串来的。
     * 后果不是"报错"，是**静默走错分支**：`dryRun === false` 不成立 ⇒ 真删永远变干跑，
     * 模型看到的还是一句"干跑"，会以为"库里没东西可删"。
     *
     * 这与开发日志 1388 行"布尔被宿主字符串化已证伪"的旧结论相反 —— **旧结论是错的**，
     * 现在实测为真（旧结论来自 2026-11-04 的三方报告交叉核对，没在真机上复现过）。
     *
     * 判据：`true` / `'true'` / `1` 算真；`false` / `'false'` / `0` 算假；
     * 其余（undefined/null/别的）一律按**没给**处理 —— 默认安全（干跑、不 fix）。
     *
     * @param {unknown} v
     * @returns {boolean}
     */
    function wantsTrue(v) {
        return v === true || v === 'true' || v === 1;
    }

    /**
     * ★ S9.40：`false` 的宽容认法（`wantsTrue` 的反面）。
     * **只有明确给 false 才当真删**；没给 = 干跑（默认安全，S7 假开关教训）。
     *
     * @param {unknown} v
     * @returns {boolean}
     */
    function wantsFalse(v) {
        return v === false || v === 'false' || v === 0;
    }

    /**
     * ★ S9.40：数字参数的宽容认法（`days`/`limit`/`offset` 同族）。
     * 调用方可能把数字按字符串送来（实测 `days:3650` → `"3650"`）。
     * 只收**纯数字串**；`"false"`/`"abc"` 这种不是数字的按"没给"处理（NaN 会污染 SQL 绑定）。
     *
     * @param {unknown} v
     * @returns {number|undefined} 能认成数字就给数字，认不出给 undefined
     */
    function numOr(v) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
        return undefined;
    }

    /**
     * ★ 2026-11-12：窗口化片段的**可见边界**（设计确定：案的第②条修法）。
     *
     * 病根：`buildSnippet` 回的是"原文的一段连续切片"，按设计**不插标记**
     * （`libs/snippet.js` 三条不许违反之①）。省上下文这一点没错，但副作用是
     * **模型看不出这是片段** —— 它以为拿到的就是那一块的全部。
     *
     * 修法：标记加在**渲染层**（这里），不动 `snippet.js` 的切片算法本身。
     * 于是"原文永不被污染"和"模型知道自己在看片段"两件事同时成立。
     *
     * @param {string} fullText 块原文
     * @param {string} snippetText 实际回给模型的窗口
     * @returns {string} 空串（整块都给了）或一行后缀
     */
    function windowMark(fullText, snippetText) {
        const full = Buffer.byteLength(fullText, 'utf8');
        const shown = Buffer.byteLength(snippetText, 'utf8');
        if (shown >= full) return '';          // 整块给完 = 无需标注
        const totalLines = fullText === '' ? 0 : fullText.split('\n').length;
        const shownLines = snippetText === '' ? 0 : snippetText.split('\n').length;
        return `\n〔片段：${shown}/${full} B · 本段 ${shownLines} 行 / 原文 ${totalLines} 行 —— 要全文加 full:true〕`;
    }

    /**
     * ★ 2026-11-12（设计确定：案）：`full:true` 拼回时**剥掉相邻块的边界重叠行**。
     *
     * 病根：`05-analyze.chunkPlainText` 用 `overlap = 2` 切块（相邻块共享 2 行，
     * 为的是召回时上下文不断裂）。这在**检索**时是对的，但**整源拼回**时
     * 那 2 行会变成重复内容 —— 实测 `run` 的 200 行输出拼回 222 行（重复 22 处）。
     *
     * ── 设计口径：只剥"边界重叠"，不剥"内容重复" ──
     *
     * `chunkPlainText` 的 overlap 是**尾→头**方向：第 k 块的**最后 n 行** =
     * 第 k+1 块的**最前 n 行**。所以要剥的是"当前块头部"里、上一块尾部已经出现过的那几行。
     *
     * 三条保守约束（宁可少剥，不可错剥）：
     *   ① **只比边界**：拿上一块的**尾部**（最后 `CHUNK_OVERLAP_MAX_LINES` 行）与当前块的
     *      **头部**逐行比对，只剥完全相同的连续前缀。正文中间相同的两行**不碰**
     *      —— 日志里真的会有两行一模一样的输出，全局去重会误删真内容。
     *   ② **上限硬顶**：最多剥 `CHUNK_OVERLAP_MAX_LINES` 行。分块器的 overlap 是常数 2，
     *      所以 2 够用；留到 8 是给将来 overlap 调大留余量，同时防"两块内容高度相似"
     *      时一路剥光。
     *   ③ **永不吐空块**：一块剥完若没有剩余内容，就**整块丢弃**（它没有新内容）。
     *      典型场景是 `chunkPlainText` 的**尾部残留块** —— 实测 200 行会切出第 12 块
     *      只有 2 行，且那 2 行与前块末尾完全重合。丢弃它不算丢数据，
     *      但这些行要照实记进 `strippedLines`。
     *
     * 为什么不能简单粗暴去重（比如全源 Set 去重）：仓库里大量日志类内容本身就有
     * 重复行（`run` 输出里同一行命令结果出现 N 次是常态），全局去重 = 静默丢数据。
     *
     * @param {Array<{title?:string, content:string}>} chunks 按 rowid 顺序的块
     * @returns {{chunks:Array, strippedLines:number}} 处理后的块 + 总共剥了几行
     */
    function stripChunkOverlap(chunks) {
        if (!Array.isArray(chunks) || chunks.length <= 1) {
            return { chunks: Array.isArray(chunks) ? chunks : [], strippedLines: 0 };
        }
        const out = [];
        let strippedLines = 0;
        /** 上一块（处理后）的尾部行，供下一块比对 */
        let prevTail = [];

        for (const c of chunks) {
            const content = String(c?.content ?? '');
            const lines = content.split('\n');
            let skip = 0;
            // ① 只比边界：上一块尾部 vs 当前块头部，逐行比，最多 CHUNK_OVERLAP_MAX_LINES 行
            if (prevTail.length > 0) {
                const cap = Math.min(CHUNK_OVERLAP_MAX_LINES, prevTail.length, lines.length);
                let n = 0;
                // 从长到短试：找**最长**的、上一块尾部后缀 == 当前块头部前缀 的行数
                for (let k = cap; k >= 1; k -= 1) {
                    const tailPart = prevTail.slice(prevTail.length - k);
                    const headPart = lines.slice(0, k);
                    if (tailPart.length === k && headPart.length === k
                        && tailPart.every((ln, i) => ln === headPart[i])) {
                        n = k;
                        break;
                    }
                }
                skip = n;
            }
            const kept = skip > 0 ? lines.slice(skip) : lines;
            strippedLines += skip;
            const nextContent = kept.join('\n');
            // ③ 永不吐空块：**整块都被上一块覆盖**（典型是 chunkPlainText 的尾部残留块，
            //    实测 200 行会切出第 12 块只有 2 行，且那 2 行与前块末尾完全重合）——
            //    这时整块丢弃，不计入输出，但**仍记入 strippedLines**（如实报"剥了几行"）。
            //    这不是"剥空"，是"这一块没有新内容"。
            if (nextContent.trim() === '' && lines.length > 0) {
                // 不 push；prevTail 保持上一块的值不变（链式比对继续对得上）
                continue;
            }
            out.push({ ...c, content: nextContent });
            // 记下本块尾部（用**处理后**的内容，保证链式比对不串位）
            prevTail = nextContent.split('\n');
        }
        return { chunks: out, strippedLines };
    }

    /**
     * ★ 2026-11-12：`recall{full:true}` 的正文（设计确定：案）。
     *
     * 回到设计本意：`run` 超 5KB 入库之后回的 source 标签，**是为了"需要全文时
     * 能全部取回"**（维护方 2026-11-12 原话）。乙档窗口化把这句承诺架空了一半，
     * 这里把另一半补上，且**只走显式开关** —— 日常召回的省上下文口径一字不动。
     *
     * 两条取法（强 → 弱）：
     *   ① 给了**精确 label**（`run` 回执里那个）→ `getChunksBySource` 按 rowid
     *      把整源全部块原样拼回。这是**真全文**：连窗口会切掉的中段都在。
     *   ② 没给精确 label → 退回 `search` 命中的块，但**整块不切窗口**。
     *
     * 预算与可见性（★ 2026-11-12 第二次定案）：正文预算 = `RECALL_FULL_BUDGET_BYTES`
     * 减去 `RECALL_FULL_WRAPPER_RESERVE_BYTES`（标题/分隔/尾提示的余量），保证**整个返回
     * 文本 ≤ 40,000**，不再被平台层 `output-containment` 拦腰砍。
     *
     * 超预算的块**整块跳过**（不截半块，半块最容易被误读成"原文就这么长"），
     * 并在末尾**明确指路：剩下的去读文件**（维护方 2026-11-12：「再多内容就应该去读文件了」）。
     *
     * ★★ 2026-11-12 第三次定案（说明：「刚才你说的去重看看能不能一起做」）：
     *   **相邻块边界重叠行去重**。之前实测：`run` 的 200 行输出拼回 222 行、
     *   重复 22 处 —— 病根是 `chunkPlainText` 的 `overlap = 2`（相邻块共享 2 行，
     *   为的是召回时上下文不断裂）。
     *
     *   证据（两条入库路径行为**不同**，必须都兼容）：
     *     · `run` 输出 → `writePlainText` → `chunkPlainText(20 行/块, overlap 2)` ⇒ **有重叠**
     *     · `index{path}` → `kind` 默认 `markdown` → `chunkMarkdown(4096 B/块)` ⇒ **无重叠**
     *   实测 `probe:k70`（75KB .txt 走 markdown 路径）= 16 块，相邻边界重叠 **0 行**；
     *   而 `run` 回执（plain 路径）= 12 块，每处边界重叠 **2 行**。
     *
     *   去重的**保守口径**（为什么这么设计，见 `stripChunkOverlap`）：只剥"上一块尾部
     *   与当前块头部完全相同的连续行"，且最多剥 `CHUNK_OVERLAP_MAX_LINES` 行。
     *   正文中间合法的重复行**一行不动** —— 日志里真的会有两行一样的输出，
     *   全局去重会把它们误删。这是"去边界重叠"，不是"去重复内容"。
     *
     * @returns {{result:object, text:string}}
     */
    function fullRecall({ rd, queryList, source, contentType, sessionId, limit, offset }) {
        const hits = [];
        const parts = [];
        let used = 0;
        let skipped = 0;
        // 正文可用额度：总预算扣掉包装余量（见 RECALL_FULL_WRAPPER_RESERVE_BYTES 的注释）
        const bodyBudget = RECALL_FULL_BUDGET_BYTES - RECALL_FULL_WRAPPER_RESERVE_BYTES;

        const exactId = (typeof source === 'string' && source.length > 0
            && typeof rd.getSourceIdByLabel === 'function')
            ? rd.getSourceIdByLabel(source)
            : null;

        if (exactId != null && typeof rd.getChunksBySource === 'function') {
            // ── ① 整源拼回（真全文）──
            const rawChunks = rd.getChunksBySource(exactId);
            if (rawChunks.length === 0) {
                throw err('NO_INPUT', {
                    reason: `source "${source}" 在临时库没有块 —— 标签要抄 run 回执里的完整原文（临时库 14 天删线，过期就没了）`,
                });
            }
            // ★ 去边界重叠（2026-11-12 第三次定案）：按 rowid 顺序逐块剥掉与上一块尾部相同的头部行
            const { chunks, strippedLines } = stripChunkOverlap(rawChunks);
            const totalBytes = rawChunks.reduce((n, c) => n + Buffer.byteLength(String(c.content ?? ''), 'utf8'), 0);
            for (const c of chunks) {
                const body = `### ${c.title}  (${source})\n${String(c.content ?? '')}`;
                const size = Buffer.byteLength(body, 'utf8');
                if (used + size > bodyBudget) { skipped += 1; continue; }
                parts.push(body);
                used += size;
                hits.push(c);
            }
            const head = `## ${source}（全文 ${rawChunks.length} 块 / ${totalBytes} B`
                + (strippedLines > 0 ? ` · 已去重叠 ${strippedLines} 行` : '') + '）';
            const tail = skipped > 0
                ? ['', `…（一次最多 ${RECALL_FULL_BUDGET_LABEL}；本次放下 ${hits.length}/${chunks.length} 块，`
                    + `另 ${skipped} 块（约 ${Math.round((totalBytes - used) / 1024)}KB）没显示）。`
                    + `**这么多内容别再用 recall 取了 —— 直接读文件**：`
                    + `原文件还在就用 read；不在了用 ctx({op:"run"}) 里 fs 读，或用 queries 收窄。`]
                : [];
            const text = [head, parts.join('\n\n'), ...tail].join('\n');
            try { rd.touchAccessed([source]); } catch { /* 静默 */ }
            return {
                result: {
                    hits, full: true, source, sections: [head],
                    bytes: Buffer.byteLength(text, 'utf8'), totalBytes,
                    skippedChunks: skipped, strippedOverlapLines: strippedLines,
                },
                text,
            };
        }

        // ── ② 无精确 label：search 命中的块整块回，不切窗口 ──
        const seen = new Set();
        const touched = new Set();
        const sections = [];
        for (const q of queryList) {
            const found = rd.search({ query: q, limit, source, contentType, offset, sessionId }) ?? [];
            if (found.length === 0) { sections.push(`## ${q}\n(0 命中)`); continue; }
            const lines = [];
            for (const h of found) {
                const key = `${h.source}::${h.title}`;
                touched.add(h.source);
                if (seen.has(key)) continue;
                seen.add(key);
                const body = `### ${h.title}  (${h.source})\n${String(h.content ?? '')}`;
                const size = Buffer.byteLength(body, 'utf8');
                if (used + size > bodyBudget) { skipped += 1; continue; }
                parts.push(body);
                lines.push(body);
                used += size;
                hits.push(h);
            }
            sections.push(`## ${q}\n${lines.length > 0 ? lines.join('\n\n') : '(命中块超出全文预算，未显示)'}`);
        }
        if (hits.length === 0) {
            // ★ 2026-11-12 真机验收抓到：给了 source 但库里查不到时，原来只回一句
            //   「换 queries，或确认 source 标签对得上」—— 模型读不出到底是三种里的哪一种。
            //   三种原因分开说，每种都给出下一步动作（err 契约：第一行就是怎么改）。
            const why = (typeof source === 'string' && source.length > 0)
                ? `source "${source}" 在临时库查不到对应的源。三种可能：`
                    + `① 标签抄漏了（要 run 回执里那个完整原文，形如 run:shell:20261112T…-xxxxxx）；`
                    + `② 是模糊匹配标签（full:true 想走整源拼回需要**精确** label，模糊标签只能按 queries 捞块）；`
                    + `③ 已过临时库 14 天删线。请核对后用精确 source 重试，或改用 queries 不带 source。`
                : 'full:true 也没有可回的块：换 queries 再取（不带 source 时会按查询词回整块）。';
            return {
                result: { hits: [], full: true, sections, skippedChunks: skipped, noHit: true },
                text: `${sections.join('\n\n---\n\n')}\n\n（${why}）`,
            };
        }
        if (touched.size > 0) { try { rd.touchAccessed([...touched]); } catch { /* 静默 */ } }
        const tail = skipped > 0
            ? [`\n…（一次最多 ${RECALL_FULL_BUDGET_LABEL}，放不下的 ${skipped} 块没显示 —— `
                + `收窄 queries 再取；内容多就直接读文件）`]
            : [];
        const text = [sections.join('\n\n---\n\n'), ...tail].join('\n');
        return {
            result: { hits, full: true, sections, bytes: Buffer.byteLength(text, 'utf8'), skippedChunks: skipped },
            text,
        };
    }

    // ── index：写入 ──
    reg('index', {
        // ★ 2026-11-09 净身：`url` 摘除（index{url} 分支随 fetch 迁 FP，净身版 §三-2）。
        required: 'path|content|dir',
        oneLine: '写进 14 天临时库',
        async call(args) {
            const a = args ?? {};
            const given = [
                a.path ? 'path' : null,
                typeof a.content === 'string' && a.content.length > 0 ? 'content' : null,
                a.dir ? 'dir' : null,
            ].filter(Boolean);
            if (given.length === 0) throw err('NO_INPUT');
            if (given.length > 1) throw err('ONE_OF_INPUT', { given });
            const w = deps.writer;
            if (!w) throw new Error('14-tools: 08-writer 未装配');
            const pin = wantsPin(a.pin);

            // ★ R5/R7（2026-11-04 测试汇总 P0-5 / P0-6）：**pin 的可行性必须在写入之前判完**。
            //   原来的顺序是"先写、再 pin"，pin 一抛错就变成半成功：临时库有数据、
            //   长久库没有、模型收到的是异常 → 它会重试 → 重试又写一遍（配 R3 之前的
            //   固定 label 就是直接覆盖）。凡是"写完才可能失败"的前置条件，都提到写之前。
            //   · dir 形态：per-file label 是 `<dir>:<rel>`，裸的 dir 根本没有源行，
            //     整个目录塞进长久库也违反 64KB 闸 —— 直接拒，并给出可行的替代路径。
            if (pin && a.dir) {
                throw err('NO_INPUT', {
                    reason: 'pin 不能和 dir 一起用（目录下每个文件的源是 <目录>:<相对路径>，裸目录没有源；'
                        + '且长久库只存总结、有 64KB 闸）：先 index{dir} 拿文件 label，再 pin 单个文件，或用 remember 写总结',
                });
            }
            // ★ 2026-11-09 净身：`!a.url` 摘除 —— index{url} 形态已随 fetch 迁 FP（§三-2），
            //   传 url 现在连 `given` 都进不去（直接 NO_INPUT），本条判据里再写 a.url 就是空转。
            if (pin && !a.source && !a.path) {
                throw err('NO_INPUT', {
                    reason: 'pin 必须能定位到一个 label：content 形态要带 source（pin 记的是 source 这个名字），'
                        + '或改用 path 形态；只想入库不钉就删掉 pin',
                });
            }
            if (pin && !a.category) throw err('NO_SCHEMA_PIN');

            // ★ 写入的公共尾巴：sessionId（tier boost 判据列）+ category（source_category）
            const writeOpts = { source: a.source, sessionId: a.sessionId ?? a.session ?? null, category: a.category ?? null };

            // ── 目录形态（2026-11-04 P3 #13 补齐）──
            //   之前 `dir` 键压根不在 schema 里，报错却说"目录请用 dir 形态" → 死路。
            if (a.dir) {
                const r = w.writeDirectory({ ...writeOpts, path: a.dir, source: a.source ?? a.dir });
                return {
                    result: { ...r, pinned: null },
                    text: `已写入 ${r.filesIndexed} 个文件（${r.totalChunks} 块）到 ${r.label}`
                        + (r.capped ? `（目录太大，只收了前一部分：共见 ${r.totalSeen} 个文件）` : '')
                        + (r.denied ? `（${r.denied} 个被策略拒绝）` : '')
                        // ★ 2026-11-14（项目 07）：二进制文件单独报 —— 它不是"失败"，
                        //   但**也不许静默**（否则"目录里 30 个文件只入了 27 个"没人知道为什么）。
                        + (r.skippedBinary ? `（${r.skippedBinary} 个不是 UTF-8 文本，已跳过：二进制不入库）` : '')
                        + (r.failed ? `（${r.failed} 个失败）` : '')
                        + '（14 天缓存，要长期用 pin/remember）',
                };
            }

            // ★ 2026-11-09 ④步 CTX 净身：`index{url}` 分支**整段移除**（净身版 §三-2）。
            //   它靠 `web.page()` 抓正文再入库 = FETCH 动作，设计确定：性「SEARCH 之后的 FETCH 动作」
            //   随 search 一体迁 FP（净身版 §〇）。连带已同批处理：
            //   · `assertSafeUrl` import 退役（本文件零引用；url-guard.js 本体留守不删）
            //   · `required` 去 url、`given` 去 a.url（见 reg('index') 头部）
            //   · SSRF 闸用例改纯词法断言（selftest 用例㉑，见 selftest.mjs）
            //   迁出内容（FP 须重建，一条不许丢）：url 入库腿、web.page 交付语义（返回**字符串**）、
            //   空正文判 `NO_INPUT`、source 缺省=safeUrl、pin 联动。
            const kind = /\.json$/i.test(a.path ?? '') ? 'json' : (a.content && a.content.trim().startsWith('{') ? 'json' : 'markdown');
            const r = w.write({ content: a.content, path: a.path, kind, ...writeOpts });
            // ★ pin:true（2026-11-04 P3 #15 补齐）：之前这个参数被整个吞掉，
            //   临时库写了、长久库没有 → 模型以为"钉住了"，实际没钉。
            // ★ R6/R7：pin 用**实际写进去的 label**（r.label），不是入参拼出来的名字 ——
            //   R3 之后无 source 的写入会拿到引擎起的唯一 label，用入参名去找必然找不到，
            //   又变成"写完才抛错"的半成功。
            const pinned = pin ? pinSource(r.label, a.category) : null;
            return {
                result: { ...r, pinned },
                text: `已写入 ${r.label}：${r.totalChunks} 块（其中代码 ${r.codeChunks}）—— 14 天缓存，要长期用 pin/remember`
                    + (pinned ? `；已钉进长久库 #${pinned.id}` : ''),
            };
        },
    });

    // ── remember ──
    reg('remember', {
        required: 'title+content+category',
        oneLine: '手录长久经验',
        async call(args) {
            const m = deps.memory;
            if (!m) throw new Error('14-tools: 11-memory 未装配');
            const r = m.remember(args ?? {});
            return { result: r, text: `已记入长久库 #${r.id}（${r.category}）` };
        },
    });

    // ── pin ──
    reg('pin', {
        required: 'label+category',
        oneLine: '临时库 → 长久库',
        async call(args) {
            const { label, category } = args ?? {};
            if (!label || !category) throw err('NO_SCHEMA_PIN');
            const m = deps.memory; const rd = deps.reader;
            if (!m || !rd) throw new Error('14-tools: 需要 memory + reader');
            const sourceId = rd.getSourceIdByLabel(label);
            if (sourceId == null) throw err('NO_INPUT', { reason: `临时库没有 label=${label}` });
            // 按 rowid 顺序取块 → 合并一行（pin 的"多块合并成一行"就在这一句）
            const chunks = rd.getChunksBySource(sourceId);
            if (chunks.length === 0) throw err('NO_INPUT', { reason: `label=${label} 在临时库没有块` });
            const r = m.pin({ label, category, chunks, title: chunks[0].title });
            return { result: r, text: `已钉进长久库 #${r.id}：合并 ${r.fromChunks} 块 → ${r.mergedBytes} B` };
        },
    });

    // ── unpin ──
    reg('unpin', {
        required: 'label',
        oneLine: '长久库 → 临时库',
        async call(args) {
            const m = deps.memory; const w = deps.writer;
            if (!m || !w) throw new Error('14-tools: 需要 memory + writer');
            const r = m.unpin({ label: args?.label });
            const back = w.writePlainText(r.content, r.label, 20);
            return { result: { ...r, rebuilt: back }, text: `已反钉 ${r.label}：写回临时库 ${back.totalChunks} 块（重新受 14 天删线）` };
        },
    });

    // ── memory ──
    reg('memory', {
        required: 'action',
        oneLine: '长久库 list/get/setCategory/delete',
        async call(args) {
            const m = deps.memory;
            if (!m) throw new Error('14-tools: 11-memory 未装配');
            const { action, id, label, category, limit } = args ?? {};
            // ★★ 2026-11-09 M6（04-修复道AB故障）：`limit: 0` = **全量**（道 A 的取数口要全库视野）。
            //   原来这里是 `limit ?? 50` —— 传 0 会一路绑进 `LIMIT 0`（取 0 行），所以必须显式分开：
            //   不传 → 50（模型面默认，不改用户可见输出）；传 0/-1 → 全量（新语义，只给道 A 用）。
            const listLimit = (limit === undefined || limit === null) ? 50 : numOr(limit);
            if (action === 'list') {
                const rows = await m.list({ limit: listLimit });
                return { result: rows, text: render(rows) };
            }
            if (action === 'get') {
                // ★ R12（2026-11-04 测试汇总 P1-2）：原来只认 id，给 label 会抛
                //   `ERR_INVALID_ARG_TYPE: Provided value cannot be bound to SQLite parameter 1`。
                //   label 本来就是长久库的行标识（pin/unpin 都按 label），读面必须同口径。
                const key = (id !== undefined && id !== null) ? id : label;
                if (key === undefined || key === null || key === '') {
                    throw err('NO_INPUT', { reason: 'memory get 要给 id 或 label（list 里两个都有）' });
                }
                const r = m.get(key);
                if (!r) throw err('NO_INPUT', { reason: `没有 id=${key} 也没有 label=${key}（用 op:"memory" action:"list" 看现有条目）` });
                return { result: r, text: `#${r.id} ${r.title}（${r.category}）label=${r.label}\n${r.content}` };
            }
            if (action === 'setCategory') return { result: m.setCategory({ id, category }), text: `#${id} → ${category}` };
            if (action === 'delete') return { result: m.remove({ id }), text: `已删除长久库 #${id}（这是唯一允许删长久记忆的入口）` };
            if (action === 'stats') return { result: m.stats(), text: render(m.stats()) };
            throw err('NO_INPUT', { reason: 'action 只认 list/get/setCategory/delete' });
        },
    });

    // ── stats ──
    reg('stats', {
        required: '—',
        oneLine: '省了多少 + 库状态',
        async call() {
            const rd = deps.reader; const lc = deps.lifecycle;
            const out = {};
            if (rd) { out.db = rd.getStats(); out.state = rd.getIndexState(); }
            // ★ R13（2026-11-04 测试汇总 P1-3）：fileBytes 现在是**主库+WAL 合计**，
            //   明细单列出来 —— 只报合计会让"要不要 checkpoint/vacuum"没法判断
            //   （WAL 涨到主库两倍时，问题不在数据量，在于没 checkpoint）。
            if (lc) {
                const d = lc.fileBytesDetail ? lc.fileBytesDetail() : { dbBytes: lc.fileBytes(), walBytes: 0, totalBytes: lc.fileBytes() };
                out.fileBytes = d.totalBytes;
                out.fileBytesDetail = d;
            }
            if (deps.memory) out.memory = deps.memory.stats();
            // ★★ 2026-11-14（项目 07）：道 A 摘除后，这里**只报道 B**（压缩回放）。
            //
            //   修前：`hints` 优先读生产真池（platform 注入的道 A `hintState`），
            //   没有才回退读引擎 `10-recall._state()`。道 A 的件、池、注入口全删了，
            //   回退口也没了 —— `10-recall` 的 `recallHints` 本轮一并摘除。
            //   历史留档（别丢，这是"形式在位 ≠ 语义在位"的原始案例）：
            //     2026-11-06 S9.44 实测 —— 引擎 `10-recall._state()` 在生产上**零调用方**，
            //     seenA 恒 0 = 那一行数是死的；修法是"生产真池由装配层注入"。
            //     现在注入的池维护方换成 `ours/precompact.js` 的 `playbackState()`。
            let live = null;
            try { live = deps.hintState ? deps.hintState() : null; } catch { live = null; }
            if (live !== null && typeof live === 'object') {
                out.hints = live;
                out.hintsSource = 'precompact(ours,道B压缩回放)';
            }
            return { result: out, text: render(out) };
        },
    });

    // ── doctor ──
    reg('doctor', {
        required: '—',
        oneLine: '体检（fix 才修）',
        async call(args) {
            const lc = deps.lifecycle;
            if (!lc) throw new Error('14-tools: 12-lifecycle 未装配');
            const d = lc.doctor();
            if (wantsTrue(args?.fix)) {
                // fix 只做可逆维护（optimize/checkpoint），绝不动结构、绝不删数据
                lc.optimize();
                lc.checkpoint('PASSIVE');
                d.fixed = ['optimize', 'checkpoint(PASSIVE)'];
            }
            const lines = d.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${c.ok ? '' : `  → ${c.fix}`}`);
            return { result: d, text: `${d.failed === 0 ? '体检通过' : `${d.failed} 项异常`}（${d.total} 项）\n` + lines.join('\n') };
        },
    });

    // ── maint ──
    reg('maint', {
        required: 'action',
        oneLine: 'plan/retention/optimize/checkpoint/integrity/vacuum',
        async call(args) {
            const lc = deps.lifecycle;
            if (!lc) throw new Error('14-tools: 12-lifecycle 未装配');
            const { action, dryRun, days } = args ?? {};
            // ★ S9.40：`days` 也可能是字符串（实测 `"3650"`）—— 认成数字再递下去，
            //   否则 SQLite 拿到文本会按 `'-3650 days'` 拼进 datetime，判据失真。
            const nDays = numOr(days);
            if (action === 'plan') return { result: lc.plan(nDays), text: render(lc.plan(nDays)) };
            if (action === 'retention') {
                // ★ S9.40：`dryRun === false` → `wantsFalse(dryRun)`（认 'false'/0）。
                //   原来用严格相等，调用方把布尔按字符串送来时判据不成立 ⇒ 真删永远变干跑。
                if (wantsFalse(dryRun)) {
                    const r = lc.retention({ days: nDays, dryRun: false });
                    return { result: r, text: `已真删：${r.deletedSources} source / ${r.deletedChunks} chunks / ${r.deletedTrigram} trigram（不可救）` };
                }
                const p = lc.plan(nDays);
                return { result: p, text: `干跑：将删 ${p.wouldDeleteSources} source / ${p.wouldDeleteChunks} 块（最老 ${p.oldest}）\n确认要删就加 dryRun:false` };
            }
            if (action === 'optimize') return { result: lc.optimize(), text: 'FTS5 段已合并' };
            if (action === 'checkpoint') return { result: lc.checkpoint('PASSIVE'), text: 'WAL checkpoint(PASSIVE) 完成（不卡并发读者）' };
            if (action === 'integrity') {
                const r = lc.integrityCheck();
                return { result: r, text: r.ok ? '完整性 ok（sqlite + fts5）' : `完整性异常：${r.sqlite} / ${r.fts5} —— 只读报警，不会自动重建` };
            }
            if (action === 'vacuum') {
                const real = wantsFalse(dryRun);
                const r = lc.vacuum({ dryRun: !real, confirm: real });
                return { result: r, text: r.vacuumed ? `VACUUM 完成：${r.beforeBytes} → ${r.afterBytes} B` : `干跑：可回收 ≈${r.reclaimableBytes} B（当前 ${r.fileBytes} B）\n真要跑加 dryRun:false（314MB 库会很久）` };
            }
            throw err('NO_INPUT', { reason: 'action 只认 plan/retention/optimize/checkpoint/integrity/vacuum' });
        },
    });

    // ── purge ──
    reg('purge', {
        required: 'scope',
        oneLine: '显式清除',
        async call(args) {
            const { scope, dryRun, session, source } = args ?? {};
            const lc = deps.lifecycle; const w = deps.writer; const rd = deps.reader;
            if (!scope) throw err('NO_INPUT', { reason: 'purge 需要 scope=session|source|project' });
            if (scope === 'project') {
                // ★ S9.40 维护方决定「删整库必须我同意」：
                //   project = 整库蒸发（三表全清、不可撤销）。
                //   ① 不管给不给 dryRun:false，**都报错** —— 原来不带 dryRun:false 时回的是一句
                //      干跑文案，模型看不出自己被挡了，像"它只是报了个数"。
                //   ② 错误码换成 PURGE_PROJECT_NEEDS_OWNER：原来复用 RETENTION_NEEDS_EXPLICIT，
                //      那条的通用 fix 是「确认要删就显式给 dryRun:false」—— 对 project 是**错的指路**，
                //      照着做仍然会被挡，模型只会反复重试。
                throw err('PURGE_PROJECT_NEEDS_OWNER', {
                    scope: 'project',
                    note: '整库删除只能维护方手动执行（不走 op）',
                });
            }
            if (!deps.purger) throw new Error('14-tools: purge 实现未注入');
            // ★ R2（2026-11-04 测试汇总 P0-3）：这里原来**不管干跑还是真删，一律回"已按 X 清除"**。
            //   purge 默认是干跑（12-lifecycle 的 `dryRun !== false`），于是模型看到"已清除"、
            //   库里一行没少 —— 假成功比报错更坏：它会拿这句当证据继续往下写结论。
            //   现在按真实结果分叉：干跑只报"将删多少行"，真删才报"已删多少行"。
            // ★ S9.40：dryRun 归一 —— 引擎层的判据是 `dryRun !== false`（严格相等），
            //   调用方把布尔按字符串送来（实测 "false"）时引擎判成"不是 false" ⇒ 走干跑。
            //   这里在工具层先归一成真布尔再递下去：明确给 false 才真删，其余一律干跑。
            const res = deps.purger({ scope, session, source, dryRun: wantsFalse(dryRun) ? false : true });
            const n = (v) => Number(v ?? 0);
            if (res && res.dryRun === true) {
                const would = n(res.wouldDelete);
                return {
                    result: res,
                    text: `干跑（**未删任何东西**）：scope=${scope} 将命中 ${would} 个${scope === 'session' ? '源（按 session 的块归属）' : '源'}\n`
                        + `确认要删就重发同一条并带 dryRun:false`
                        + (res.samples?.length ? `\n样本：${res.samples.map((s) => s.label ?? s.source_id ?? JSON.stringify(s)).join(' | ')}` : ''),
                };
            }
            const dc = n(res?.deletedChunks); const dt = n(res?.deletedTrigram); const ds = n(res?.deletedSources);
            return {
                result: res,
                text: `已按 ${scope} 真删：sources ${ds} 行 / chunks ${dc} 行 / trigram ${dt} 行`
                    + (dc + dt + ds === 0 ? '（一条都没命中 —— 检查 session/source 的值）' : ''),
            };
        },
    });

    // ── switch：工具开关（Tool Switch）—— 关掉/打开宿主工具，即时生效 ──
    //
    // ★ 为什么这个 op 自己不干活：真正能施加/撤销限制的是**宿主**的
    //   `agent.ctx.tools.restrict()` 与它返回的 disposer，引擎是平台无关纯库，
    //   碰不到 Cordis。所以实现落在 `platform/tool-switch.js`，装配时经
    //   `deps.toolSwitch` 注进来（与 web / purger 同一个接缝）。
    //
    // ★ 关与开是**同一条路的两面**：off = 存下 restrict 的 disposer，
    //   on = 撤那个 disposer。**不许**用"反向 mask"去开 —— restrict 是交集语义，
    //   叠一个 allow 只会越叠越窄，永远开不回来（这一条写死在 platform 那侧）。
    reg('switch', {
        required: 'action',
        oneLine: '工具开关 list/off/on（全局+落盘：换会话/重启都保持）',
        async call(args, runtime) {
            const sw = deps.toolSwitch;
            if (!sw) {
                throw err('NO_HOST_CAP', {
                    reason: '工具开关需要宿主 tools 服务：本引擎是独立跑的（--selftest / 无宿主），拿不到 agent 作用域，'
                        + '无法把限制挂到"谁"身上。真机上由 platform/tool-switch.js 注入后才可用。',
                });
            }
            const { action, tool } = args ?? {};
            const act = String(action ?? 'list').trim() || 'list';
            // exec 形状对齐：platform 那侧只认 `{agent}`（restrict 只认 scoped ctx）。
            // ★ 这里**不许**用 runtime?.session 兜底当 agent —— session 上没有 .ctx，
            //   拿它顶替会在 restrict 处抛一句看不懂的话（scope 是 undefined）。
            const exec = { agent: runtime?.agent };
            if (act === 'list') return sw.list(exec);
            if (act === 'off') return sw.off(tool, exec);
            if (act === 'on') return sw.on(tool, exec);
            throw err('UNKNOWN_ACTION', {
                action: act,
                reason: `action 只认 list / off / on（收到 "${act}"）。list 看全部工具与状态；off 关；on 开。`,
            });
        },
    });

    // ── list：自描述 ──
    reg('list', {
        required: '—',
        oneLine: '不传 op 时返回这张表（自描述）',
        async call() {
            const table = [...ops.values()].map((o) => ({ op: o.op, required: o.required, oneLine: o.oneLine }));
            return { result: table, text: CTX_RUN_DESCRIPTION };
        },
    });

    // ★★ 文案面与运行面同构（硬规矩②）：ctx.md 的 op 行必须与注册出来的 op **一一对应**。
    //   少一行 = 模型看不到这个能力（等于没有）；多一行 = 模型会调到不存在的 op（等于撒谎）。
    //   漂移在装配当场抛，而不是等门来扫 —— 门只扫成品，这里守每一次真装配。
    const declared = opsDeclaredIn(CTX_RUN_DESCRIPTION);
    const missing = [...ops.keys()].filter((op) => !declared.includes(op));
    const extra = declared.filter((op) => !ops.has(op));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(`14-tools: ctx.md 与注册表漂移 —— 注册了但文案没有：[${missing.join(',')}]`
            + `；文案有但没注册：[${extra.join(',')}]（改文案就改 descriptions/ctx.md，别碰这里）`);
    }

    return {
        ops: () => [...ops.keys()],
        opTable: () => [...ops.values()].map((o) => ({ op: o.op, required: o.required, oneLine: o.oneLine })),
        get: (op) => ops.get(op),
        description: CTX_RUN_DESCRIPTION,
        render,
    };
}

export function init(ctx) { ctx.toolsFactory = createTools; }
