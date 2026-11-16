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
 * platform/tool-def.js — 积木④：MCP 工具 → DSH 工具定义的翻译。
 *
 * 归属：**自有**（翻译层；第三方 /server.js 的注册面是参考，不是运行路径）。
 *
 * 唯一分支点 = 参数适配（vanilla 直通 / bubble CJK）—— 2026-11-04 起**描述不再有分支**：
 * 文案面进了引擎 `blocks/14-tools/descriptions/ctx.md`，两种模式拿到的是同一份引擎原文。
 * 执行转发、输出渲染、互斥集合三种形态完全相同 —— 这是刻意的：
 * 分支要是长到执行路径里，两个形态的行为就会开始漂移。
 */

import { EXCLUSIVE_CONTEXT_TOOLS } from './catalog.js';
import { validateEscalationArgs } from './escalation.js';

/** DSH 工具结果的统一输出 schema（所有 ctx_* 工具共用）。 */
export const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
};

/**
 * 把 MCP 的 content 数组压成一段文本。
 * @param {{ content?: Array<{ type: string, text?: string }> }} result
 * @returns {string}
 */
export function renderMcpContent(result) {
    const text = (result.content ?? [])
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
    if (text.length > 0)
        return text;
    return result.content === undefined ? '' : JSON.stringify(result.content);
}

/**
 * 把**扁平属性表**编译成宿主要的 **JSON Schema**。
 *
 * ★ 2026-11-06 S9.37 宿主契约实证（源码从 app.asar 抽出，见开发日志 S9.37）：
 *   宿主有两条注册路，形状要求相反：
 *     ① `ctx.tools.register(defineTool({...}))` —— `defineTool` 内部用
 *        `parameterSchemaSpecToJsonSchema()` 把**扁平表**编译成 JSON Schema；
 *     ② `ctx.tools.register(裸对象)` —— **原样保留** `definition.parameters`，
 *        宿主 `schemaOf()`（`dsh-tools/lib/index.js:3135`）直接投影给模型。
 *   **我们走的是 ②**，所以必须自己编译。
 *
 * 编译规则（照宿主 `runSchemaCompiler` 的 property-map 分支逐条对齐）：
 *   · 每个属性的 `required: true` → 收进**根**的 `required` 数组；
 *     属性自身**不再保留** `required` 键（宿主 `assertAuthorKeys` 不允许它留在节点上）。
 *   · `type` 原样保留；`description` / `title` / `default` / `examples` 是注解，原样保留
 *     （宿主 `copyAnnotations` 只搬这四个）。
 *   · `enum` / `const` 原样保留。
 *   · 空表 → `{ type: 'object', properties: {} }`。
 *
 * @param {Record<string, unknown>} flat 扁平属性表 `{名: {type, description, required?}}`
 * @returns {{type: 'object', properties: Record<string, unknown>, required?: string[]}} JSON Schema
 */
export function compileParametersToJsonSchema(flat) {
    const properties = {};
    const required = [];
    if (flat !== null && typeof flat === 'object' && !Array.isArray(flat)) {
        for (const [key, rawSpec] of Object.entries(flat)) {
            if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) continue;
            const spec = { ...rawSpec };
            // required 只允许 true；收进根数组后从属性上摘掉。
            if (Object.hasOwn(spec, 'required')) {
                if (spec.required === true) required.push(key);
                delete spec.required;
            }
            properties[key] = spec;
        }
    }
    const schema = { type: 'object', properties };
    if (required.length > 0) schema.required = required;
    return schema;
}

/**
 * 引擎给的是**完整 JSON Schema**（`{type:'object', properties:{…}, required:[…]}`），
 * 而 DSH 的 `defineTool({parameters})` 要的是**扁平属性表**（`{名: {type,…}}`）——
 * 它在 `parameterSchemaSpecToJsonSchema()` 里自己补 `type:'object'` + `properties` + `required`。
 *
 * ★ 2026-11-05 修：原来这里直接把 JSON Schema 原样透传给 `parameters`，
 *   宿主按"参数名 → 定义"去读那份 schema，只读到 `type` / `properties` / `required`
 *   三个**假参数**（它们都没有 description）—— 于是工具定义下面显示「（无参数）」，
 *   34 个真参数一个都不露，模型只能靠 ctx.md 正文猜参数名。
 *
 * 判据：`parameters.type === 'object' && parameters.properties` 是 JSON Schema 形态，
 *   要拆成扁平表；已经是扁平表（没有 type/properties 包裹）就原样返回。
 *
 * required 的处理：DSH 的扁平表用 `required: true` 标必填（见 dsh-tool-fs 的写法），
 *   所以把 `properties` 里每个键挑出来，命中 schema.required 的补 `required: true`。
 *
 * ⚠️ ★★ 2026-11-06 S9.37 **本函数的产物不是"递给宿主的最终形状"，是"待编译的中间形状"。**
 *   上面那段注释说的 `defineTool({parameters})` 要扁平表 —— **只对 `defineTool` 成立**，
 *   而**我们从来没用 `defineTool`**：我们走的是 `ctx.tools.register(裸对象)`
 *   （`overlay/platform/plugin.js:238`），那条路的契约是**原样保留** `definition.parameters`，
 *   宿主 `schemaOf()`（`dsh-tools/lib/index.js:3135`）直接把它投影给模型。
 *   ⇒ 喂扁平表进去，宿主按 JSON Schema 读，只读到 `type`/`properties`/`required` 三个假键
 *   ⇒ **界面又显示「（无参数）」**（与 2026-11-05 那次同一个坑的两面）。
 *   修法见下方 `compileParametersToJsonSchema()`：编译成 JSON Schema 后再交出去。
 *
 * @param {unknown} inputSchema 引擎的 inputSchema（JSON Schema 或已是扁平表）
 * @returns {Record<string, unknown>} 扁平属性表（**待编译**，不是最终形状）
 */
export function normalizeParameters(inputSchema) {
    // ★ null 必须单独挡：typeof null === 'object'，会一路穿到 .toJSONSchema 上炸。
    //   （1.2.1remix 老版本这里是 `inputSchema === undefined || ...`，null 会被原样
    //   返回给 DSH —— parameters: null 是非法形状，属潜伏缺陷，本次一并堵掉。）
    if (inputSchema === undefined || inputSchema === null
        || Array.isArray(inputSchema) || typeof inputSchema !== 'object') {
        return {};
    }
    let schema = inputSchema;
    // zod v4 实例带 toJSONSchema()：能转就转，转不了就退
    if (typeof schema.toJSONSchema === 'function') {
        try {
            const bare = schema.toJSONSchema();
            if (bare !== null && typeof bare === 'object') schema = bare;
        }
        catch { /* 落到下面的兜底 */ }
    }
    // 克隆安全闸（1.2.2 事故）：不可克隆就退成空表，宁可少提示也不许炸宿主
    if (!isCloneable(schema)) {
        const safe = stripMeta(schema);
        if (!isCloneable(safe)) return {};
        schema = safe;
    }
    schema = stripMeta(schema);
    // —— JSON Schema → 扁平参数表 ——
    const props = schema.type === 'object' && schema.properties !== null
        && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties : undefined;
    if (props === undefined) {
        // 不是 {type:'object',properties} 形态：当作"已经是扁平表"，原样给出去。
        //   这条兜底是为第三方引擎/老路径留的 —— 空表只影响参数提示，工具照样能调。
        return schema;
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const flat = {};
    for (const [key, value] of Object.entries(props)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        flat[key] = required.has(key) ? { ...value, required: true } : { ...value };
    }
    return flat;
}

/** `$schema` 只是自描述键，DSH 侧不需要。@param {unknown} node */
function stripMeta(node, depth = 0) {
    if (depth > 32) return node;
    if (Array.isArray(node)) return node.map(item => stripMeta(item, depth + 1));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === '$schema' || typeof value === 'function') continue;
        out[key] = stripMeta(value, depth + 1);
    }
    return out;
}

/** @param {unknown} value */
function isCloneable(value) {
    try {
        structuredClone(value);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * CJK 双向适配 —— ★ 2026-11-04 **整体退役**（原 adaptArguments）：
 *   它是 vendored 时代的桥侧补丁：第三方 /FTS5 只认 porter+unicode61，中文不铺开就搜不到。
 *   自有引擎里 07-tokenize/gram 通道在**写入侧**就做了中文分词（三榜里有 gram 榜），
 *   桥侧再铺一遍 = 同一件事两份实现，而且铺过的 content 进我们的分块器会变形。
 *   cjkAdapt 开关恒 false 之后这条路从未执行（G10⑨ 的 e 项就是原样转发证明）。
 *   ours/cjk.js 仍被 precompact.js 用（归档文本入库的分段），那不是死件，留着。
 */

/**
 * 翻译成一个 DSH 工具定义。
 *
 * ★ 2026-11-04 沙箱归一（P4/P5）后本函数只剩一条正路：参数原样转发 + signal/session/
 *   callId/policyOverride 作 runtime 递引擎。原先的第三参 `opts`（cjkAdapt 分支）
 *   **整体退役** —— 那个开关恒 false，分支永不执行（"待实测裁决"的裁决就是：
 *   CJK 分词归引擎 07-tokenize/gram，vendored 时代在桥侧铺开的补丁没有存在的理由了）。
 *   描述也无分支（文案真源 descriptions/ctx.md，S9.20）。死路径连着死开关一起删。
 *
 * @param {any} tool - MCP tools/list 的一项
 * @param {object} deps - 依赖注入（便于自测替换）
 * @param {(name: string, args: unknown, signal: AbortSignal, meta?: {session?:unknown, callId?:unknown, policyOverride?:string}) => Promise<any>} deps.callTool
 * @param {(msg: string) => void} [deps.diagnose] - 一次性 exec 形状快照的出口（可缺）
 * @param {(req:{requestedMode:string, justification:string, exec:object}) => Promise<string>} [deps.escalate]
 *        ★ P5 审批流：宿主批准则返回更宽 mode（仅本次调用）。没组审批服务时缺省 ——
 *        模型带 sandbox_permissions 来会得到可读拒绝（不静默降级）。
 * @returns {Record<string, unknown>} DSH 工具定义
 */
let execSnapshotDone = false;
export function toDefinition(tool, deps) {
    return {
        name: tool.name,
        // ★ 2026-11-04 文案面进 ctx.md（引擎 blocks/14-tools/descriptions/）：
        //   描述就是 ctx.md 本体，`{{webSearchUrl}}` 已由引擎 attachBridgeContract
        //   用平台层传来的 webUrl 填好（engine-client 注入）。平台层再填一次 = 两份实现，
        //   ours/description.js 整件删除。vanilla/bubble 拿到的是同一份引擎原文。
        description: tool.description,
        // ★ 2026-11-06 S9.37：这里必须交 **JSON Schema**，不能交扁平表。
        //   我们走的是 `ctx.tools.register(裸对象)`（不是 `defineTool`）——
        //   那条路**原样保留** `definition.parameters`，宿主按 JSON Schema 读。
        //   交扁平表 ⇒ 宿主只读到 `type`/`properties`/`required` 三个假键
        //   ⇒ 工具定义下面显示「（无参数）」，34 个真参数一个都不露（静默降级，工具照样能调）。
        //   normalizeParameters 先把引擎的 JSON Schema 拆成扁平表，再由
        //   compileParametersToJsonSchema 照宿主规则编译回去 —— 与 defineTool 等价。
        parameters: compileParametersToJsonSchema(normalizeParameters(tool.inputSchema)),
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
                const text = typeof record?.text === 'string' ? record.text : String(value);
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            // ★ 真机 exec 形状一次性快照（P2/P5 的未知数：插件工具的 exec 到底带不带
            //   session/callId）。维护方重装后随便调一次 ctx，日志里就有这一行。
            if (!execSnapshotDone) {
                execSnapshotDone = true;
                deps.diagnose?.(`exec shape: keys=[${Object.keys(exec ?? {}).join(',')}] signal=${exec?.signal ? 'yes' : 'no'} callId=${exec?.callId ?? '(none)'} agent.session=${exec?.agent?.session?.id ? 'yes' : 'no'}`);
            }
            // ★ P4（2026-11-04 沙箱归一）：这里**没有沙箱短路了** —— guard（ours/sandbox-exec.js）
            //   整件删除，受限执行走下面同一条正路：signal/session 作 runtime 进引擎，
            //   13-sandbox 里 confine+policy 逐会话生效。by_tool 恒 0 的时代结束。
            //
            // ★ P5 审批流（与 pwsh 平权）：args 里的 sandbox_permissions/justification
            //   是"给宿主的申请"，不是 op 参数 —— 先校验成对、走宿主审批，
            //   批了才把批准的 mode 作 policyOverride 递进引擎（仅本次调用），
            //   并从转发参数里剥掉（引擎不认识这两个键）。拒绝=抛，模型收到原话。
            const forwardArgs = { ...args };
            const requestedMode = forwardArgs.sandbox_permissions;
            const justification = forwardArgs.justification;
            delete forwardArgs.sandbox_permissions;
            delete forwardArgs.justification;
            let policyOverride;
            if (requestedMode !== undefined || justification !== undefined) {
                if (typeof deps.escalate !== 'function') {
                    validateEscalationArgs(requestedMode, justification); // 坏对先报坏对
                    throw new Error(`ctx: sandbox escalation to "${requestedMode}" is unavailable on this host (no approval service composed) — it stays denied`);
                }
                policyOverride = await deps.escalate({ requestedMode, justification, exec });
            }
            const result = await deps.callTool(tool.name, forwardArgs, exec?.signal, {
                session: exec?.agent?.session ?? exec?.session,
                callId: exec?.callId,
                policyOverride,
                // ★ 2026-11-05 Tool Switch：**必须把 live agent 递下去**。
                //   工具开关的 off/on 只能在 agent 作用域上 restrict（全局 ctx 会抛），
                //   而这个作用域唯一的来源就是 exec.agent.ctx。丢了它，
                //   op:switch 一律 NO_AGENT_SCOPE —— 关不了也开不了。
                //   只在有 agent 时才带键，避免给引擎塞一个 undefined 的"假 agent"。
                ...exec?.agent === undefined ? {} : { agent: exec.agent },
            });
            const text = renderMcpContent(result);
            if (result.isError)
                throw new Error(text || `${tool.name} returned an error`);
            return { text };
        },
        isConcurrencySafe: () => !EXCLUSIVE_CONTEXT_TOOLS.has(tool.name),
    };
}
