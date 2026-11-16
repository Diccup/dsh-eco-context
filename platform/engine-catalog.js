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
 * platform/engine-catalog.js — 积木⑨：引擎工具目录的形状翻译。
 *
 * 归属：**自有**。引擎注册表里登记的是 `{name, config:{description, inputSchema}, handler}`
 * （引擎自己的内部形状），宿主要的是 `[{name, description, inputSchema}]` ——
 * 本积木就是这两者之间**唯一的翻译点**。
 *
 * ═══════════════════════════════════════════════════════════
 * ★ schema 纯化的由来（2026-11-02 真实事故）
 * ═══════════════════════════════════════════════════════════
 * 1.2.2 时代引擎的 `inputSchema` 是**活的 ZodObject 实例**，不是 JSON。
 * 子进程模式走 MCP JSON-RPC 时它被自动序列化，所以一直没暴露；
 * 进程内直读就把实例递给宿主，实例上的 `extract`/`exclude` 等函数
 * 过不了结构化克隆边界 → 宿主每一轮、每个窗口、每个模型全崩：
 *
 *     本轮运行失败  ...  could not be cloned.
 *
 * 1.0.0 的引擎返回**已经是纯对象**（`{type, properties, required}`），
 * 实测两个工具的 schema 都能直接 structuredClone。所以这里的转换是**防御性**的：
 * 正常路径原样通过；万一将来引擎改了实现、递出实例，这里兜住，不让宿主崩。
 *
 * 代价不对称：一张空表只影响参数提示（工具照样能调），一个坏 schema 会让整个宿主全崩。
 */

/**
 * 需要剥离的元键。`$schema` 只是自描述，DSH 侧不用。
 * @type {Set<string>}
 */
const DROP_KEYS = new Set(['$schema']);

/**
 * 一个值能否安全过结构化克隆边界。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCloneable(value) {
    try {
        structuredClone(value);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * 深拷贝成纯数据：去元键、丢函数。
 * @param {unknown} node
 * @param {number} [depth]
 * @returns {unknown}
 */
function plainify(node, depth = 0) {
    if (depth > 32) return node;
    if (Array.isArray(node)) return node.map(item => plainify(item, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (DROP_KEYS.has(key)) continue;
        if (typeof value === 'function') continue;
        out[key] = plainify(value, depth + 1);
    }
    return out;
}

/**
 * 形状自检：顶层必须是 object 且带 properties。
 * @param {unknown} node
 * @returns {boolean}
 */
function isPlainObjectShape(node) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    if (node.type !== 'object') return false;
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties))
        return false;
    return true;
}

/**
 * 把任意 schema 形状转成可跨边界的纯 JSON Schema。
 *
 * 支持：null/undefined → 空表；普通 JSON 对象 → 深拷贝；zod v4 实例 → 调 toJSONSchema()。
 *
 * @param {unknown} schema
 * @returns {Record<string, unknown>}
 */
export function toPlainSchema(schema) {
    let candidate = schema;
    if (candidate === null || candidate === undefined || Array.isArray(candidate))
        candidate = undefined;
    else if (typeof candidate === 'object' && typeof candidate.toJSONSchema === 'function') {
        try {
            const out = candidate.toJSONSchema();
            candidate = (out !== null && typeof out === 'object') ? out : undefined;
        }
        catch {
            candidate = undefined;
        }
    }
    const safe = candidate === undefined ? undefined : plainify(candidate);
    if (!isPlainObjectShape(safe) || !isCloneable(safe))
        return { type: 'object', properties: {} };
    return safe;
}

/**
 * 取一个注册条目的 inputSchema。
 *
 * ★ 2026-11-05 真缺陷（导致模型侧 34 个参数全丢的那条）：
 *   引擎 `attachBridgeContract()` 造出来的条目是
 *   `{ name, config: { description }, inputSchema, handler }`
 *   —— `config` 里**只有 description**，schema 挂在**顶层**。本文件原来写的是
 *   `entry.config?.inputSchema`，恒读到 undefined → `toPlainSchema(undefined)`
 *   退成 `{type:'object',properties:{}}` → 34 个参数一个不剩。
 *
 *   代价是静默的：工具照样能调（引擎按 args 分派，不依赖 schema），
 *   只有"参数提示"消失 —— 界面显示空的，模型只能靠 ctx.md 正文猜参数名。
 *   实测证据：`contextBreakdown` 里 `ctx` 只剩 254 token，而带 34 参数时是
 *   约 696 token；254 恰好等于 `parameters: {}` 的价格。
 *
 *   修法：**顶层优先，config 兜底**。两种形状都认 —— 老引擎（1.2.2 时代）
 *   把 schema 塞在 config 里，新引擎放顶层；同一份代码要能读两种。
 *
 * @param {{inputSchema?: unknown, config?: {inputSchema?: unknown}}} entry
 * @returns {unknown}
 */
function schemaOfEntry(entry) {
    if (entry?.inputSchema !== undefined && entry.inputSchema !== null)
        return entry.inputSchema;
    return entry?.config?.inputSchema;
}

/**
 * 把引擎的 REGISTERED_CTX_TOOLS 映射成 MCP tools/list 的形状，并把 schema 纯化。
 *
 * 引擎条目：`{name, config:{description}, inputSchema, handler}`（schema 在顶层）；
 * MCP 形状：`{name, description, inputSchema}`。
 *
 * @param {Array<{name: string, inputSchema?: unknown, config?: {description?: string, inputSchema?: unknown}}>} registered
 * @returns {Array<{name: string, description: string, inputSchema: Record<string, unknown>}>}
 */
export function catalogFromEngine(registered) {
    if (!Array.isArray(registered))
        throw new TypeError('catalogFromEngine: 需要 REGISTERED_CTX_TOOLS 数组');
    return registered.map((entry) => {
        if (typeof entry?.name !== 'string' || entry.name.length === 0)
            throw new TypeError('catalogFromEngine: 条目缺少 name');
        return {
            name: entry.name,
            description: entry.config?.description ?? '',
            // ★ 这一步是硬要求：递给宿主的必须可结构化克隆
            inputSchema: toPlainSchema(schemaOfEntry(entry)),
        };
    });
}

/**
 * 报告哪些工具的 schema 发生了转换 / 退化（诊断用，不改行为）。
 *
 * ★ 2026-11-05：本函数原来跟 `catalogFromEngine` 一样只读 `entry.config.inputSchema`，
 *   于是它和缺陷**同瞎**——真出了一份空 schema，它报的却是"无退化"。
 *   现在两处共用 `schemaOfEntry()`：判据与取数必须同源，否则体检单永远合格。
 *
 * @param {Array<{name?: string, inputSchema?: unknown, config?: {inputSchema?: unknown}}>} registered
 * @returns {{ converted: string[], degraded: string[] }}
 */
export function auditEngineSchemas(registered) {
    const converted = [];
    const degraded = [];
    for (const entry of registered) {
        const raw = schemaOfEntry(entry);
        const needsConversion = raw !== null && typeof raw === 'object' && typeof raw.toJSONSchema === 'function';
        if (needsConversion) converted.push(entry?.name);
        const plain = toPlainSchema(raw);
        // 原本有属性、转完没了 = 退化；原本就是空表（ctx_stats 一类）不算
        let rawPropCount = 0;
        try {
            const rawProps = raw?.toJSONSchema?.()?.properties ?? raw?.properties;
            rawPropCount = rawProps ? Object.keys(rawProps).length : 0;
        }
        catch { /* 拿不到就不判 */ }
        if (rawPropCount > 0 && Object.keys(plain.properties).length === 0) degraded.push(entry?.name);
    }
    return { converted, degraded };
}

/**
 * 校验引擎目录与静态事实（catalog.js 的 FULL_CATALOG）是否一致。
 * 不一致说明宿主换了注册面 —— 这是升级时必须人工确认的事，所以返回明细而不是抛。
 *
 * @param {string[]} staticNames
 * @param {Array<{name: string}>} engineCatalog
 * @returns {{ ok: boolean, missing: string[], extra: string[] }}
 */
export function compareCatalog(staticNames, engineCatalog) {
    const engineSet = new Set(engineCatalog.map(t => t.name));
    const staticSet = new Set(staticNames);
    return {
        ok: engineSet.size === staticSet.size && [...engineSet].every(n => staticSet.has(n)),
        missing: [...staticSet].filter(n => !engineSet.has(n)),
        extra: [...engineSet].filter(n => !staticSet.has(n)),
    };
}
