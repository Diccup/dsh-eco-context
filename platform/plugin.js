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
 * platform/plugin.js — **平台匹配层**入口（唯一入口，零业务逻辑）。
 *
 * 这一层为什么存在
 * ─────────────────────────────────────────────────────────
 * `engine/` 是**平台无关**的纯库（17 块积木，`createEngine()` 起一个引擎实例）。
 * 它自己不认识 DSH：不知道什么叫 Cordis 插件、不知道 `ctx.get('tools')`、
 * 不知道工具描述该怎么渲染、不知道提示词往哪注入。
 *
 * 这些「宿主长什么样」的知识，就是本层存在的**全部理由** ——
 * 把我们的软件适配到一个具体平台（目前是 DSH / Cordis）。
 * 以后要接别的宿主，新增一个 `platform-xxx/` 即可，engine/ 一行不改。
 *
 * ★ 历史（命名沿革，读代码时容易困惑，所以写在这）
 *   
 *   —— 那时引擎不是我们的（vendor 里有 675KB 的 server.bundle.mjs，走子进程
 *   JSON-RPC）。1.0.0 引擎成了自己的、并且进程内直连，桥就没有意义了：
 *   现在的职责是**平台适配**，不是"桥"。所以目录名 `bridges/` → `platform/`。
 *
 * 本文件只做"读清单 → 起引擎 → 注册工具 → 挂积木 → 记日志"，
 * 具体每件事都在自己那块积木里：
 *
 *   ② platform/catalog.js        引擎注册面事实（FULL_CATALOG / 互斥集合 / 模式注记）
 *   ③ platform/deployment.js     部署配置读取（模式系统退役后只剩 disabledTools 加法）
 *   ④ platform/tool-def.js       工具 → DSH 工具定义的翻译
 *   ⑤ platform/skill-set.js      捆绑技能装载 + 模式注记注入
 *   ⑥ platform/routing.js        system prompt 注入（路由段 + 归档指针段）
 *   ⑦ platform/runtime.js        运行时发现（node 可执行文件 / 配置默认值）
 *   ⑨ platform/engine-catalog.js 引擎目录 → 工具描述（schema 纯化）
 *   ⑩ platform/engine-client.js  进程内引擎客户端
 *   ⑧ platform/plugin.js         本文件：组装
 *
 * 自有增强积木（ours/，extras 全开，坏了只 warn 不拖工具）：
 *   output-containment / session-memory / precompact /
 *   cjk / web-search + ws 五件 / fp-bridge
 *   ★ 2026-11-04 P4：sandbox-exec（桥侧 guard）删除 —— 受限执行面进了引擎 13-sandbox。
 *
 * ★ 2026-11-03 换引擎（1.0.0）：**子进程路径整条删除**。
 *   1.0.0 只有进程内引擎（engine/ 纯源码，createEngine）。于是——
 *     · `rpc.js`（MCP JSON-RPC over stdio）、`engineMode`、`serverPath`
 *       全部失去意义：没有 bundle 可起，也没有子进程可连。
 *     · 留着它们只会让配置项指向不存在的路径、让报错文案指向不存在的退路。
 *   引擎本体是 17 块积木（engine/blocks/），本层零 handler 重写。
 *
 * 2026-11-02 起本文件**不再有 52sujiu 的血缘**：原先继承自
 * 52 `lib/types/index.js` 的 9 个函数已全部迁入各自的积木文件并重写；
 * 剩下只有 52 的资产（8 个 SKILL.md 与 modes/*.json 的数据形状），代码零继承。
 */

import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { EngineClient, resolveEngineRoot } from './engine-client.js';
import { PLATFORM_DIR } from './layout.js';
import { loadDeployment } from './deployment.js';
import { toDefinition } from './tool-def.js';
import { installBundledSkills } from './skill-set.js';
import { installPromptSections, ROUTING_TEXT, SANDBOX_ROUTING_TEXT } from './routing.js';
import { createEscalator } from './escalation.js';
import { resolveConfig } from './runtime.js';
import { installOutputContainment } from '../ours/output-containment.js';
import { archiveNotice, consumePlayback, installPrecompactArchive, playbackState } from '../ours/precompact.js';
import { installSessionMemory, setPushOffPath } from '../ours/session-memory.js';
import { createToolSwitch } from './tool-switch.js';
import { createJobHost } from './job-host.js';

export const name = 'dsh-eco-context';

export { ROUTING_TEXT, SANDBOX_ROUTING_TEXT } from './routing.js';
export { FULL_CATALOG, EXCLUSIVE_CONTEXT_TOOLS, deployNote, mountedTools } from './catalog.js';

// ★ 2026-11-04：原先这里有个 WEB_SEARCH_URL 常量喂给 tool-def 填描述占位符。
//   文案面进 ctx.md 后，占位符由**引擎**填（engine-client 把同一个 file:// URL
//   作为 createEngine({webUrl}) 传进去），平台层留两份实现迟早漂移 —— 删。

export const Config = z.object({
    enabled: z.boolean().default(true),
    // ★ 2026-11-04：`mode` 键退役 —— vanilla（原版转接）整条删除，
    //   本包只做自有形态；将来要原版体验就另写一个独立桥挂引擎实现。
    //   用户 yml 里残留的 mode 不再有任何作用（装载时告警一次，见 apply）。
    projectDir: z.string().default(''),
    storageDir: z.string().default(''),
    precompact: z.boolean().default(true),
    disabledTools: z.array(z.string()).default([]),
});

/**
 * 平台匹配入口：把 dsh-eco-context 的工具面接进 DSH（引擎进程内加载）。
 *
 * @param {any} ctx - Cordis 插件上下文
 * @param {Record<string, unknown>} [config]
 * @param {object} [seams] - 测试注入的接缝（生产不传，全走真实实现）
 * @param {string} [seams.engineRoot] - engine/ 目录（自测注入，生产走布局探测）
 */
export async function apply(ctx, config = {}, seams = {}) {
    const resolved = resolveConfig(config);
    if (!resolved.enabled)
        return;
    const profile = loadDeployment(resolved.disabledTools, ctx.logger, { mode: resolved.legacyMode });
    const tools = ctx.get('tools', false);
    if (tools === undefined) {
        ctx.logger.warn('dsh-eco-context: tools service is unavailable; plugin is inactive');
        return;
    }

    const disposers = [];
    let disposed = false;
    /** @type {EngineClient | undefined} */
    let client;
    ctx.effect(() => () => {
        disposed = true;
        // ★ 卸载路径用 retire() 而不是 shutdown()：这里是"永不回来"，
        //   自愈不该在这种时候偷偷把引擎又拉起来（会泄漏 DB 句柄与 exit 监听器）。
        //   事故现场那种"误关"走的是下面 catch 里的 shutdown()，那个是要能自愈的。
        if (typeof client?.retire === 'function')
            client.retire();
        else
            client?.shutdown();
        for (const dispose of disposers.splice(0))
            dispose();
        disposers.length = 0;
    }, 'dsh-eco-context platform plugin');

    // ---- 自有增强积木：extras 全开（模式清单退役后这是唯一形态；坏了只 warn 不拖工具）----
    //
    // ★★ 2026-11-03 G10 抓到的第三个真问题：**装饰层的强依赖会拖垮工具注册。**
    //
    //   这几块增强在 try 之外（比工具注册还早）。它们各自向宿主服务要不同的方法：
    //     session-memory.js  → systemPrompt.context()
    //     routing.js         → systemPrompt.section()
    //   若某个平台只实现其中一部分，`installSessionMemory` 一抛 →
    //   **整个 apply 失败** → 一个工具都不注册。
    //
    //   这正是 2026-11-02 那条教训的另一半：当时记的是"工具注册之后装饰层失败不许关引擎"，
    //   而现在的情形是"装饰层失败让工具**压根没注册**"。两种都必须堵。
    //
    //   处理：每块单独 try。增强是**锦上添花**，坏了顶多少点便利，
    //   绝不许它决定工具面有没有。
    const extras = profile.extras ?? {};
    const mountExtra = (label, fn) => {
        try {
            const dispose = fn();
            if (typeof dispose === 'function')
                disposers.push(dispose);
            else if (Array.isArray(dispose))
                disposers.push(...dispose.filter(d => typeof d === 'function'));
        }
        catch (error) {
            // 记 warn 不记 error：这是"少点便利"，不是"插件坏了"
            ctx.logger.warn(`dsh-eco-context: extra "${label}" unavailable on this host, tools unaffected (${errorMessage(error)})`);
        }
    };
    // ★★ 2026-11-14（项目 07）：**道 A 整条链摘除**（设计说明：「把道A去掉，不要道A推送了」）。
    //
    //   摘掉的东西（一件不剩，见 07-立项书 §2.1 R-3）：
    //     · import `createRecallHints` / `setHintConsumer`
    //     · `let hints = null` 闭包与 `mountExtra('recall-hints')` 整块（原 L162-246）
    //     · `seams.hintState` 里的道 A 半边（`hints ? hints.hintState() : null`）
    //     · `deployment.js` 的 `extras.recallHints`
    //
    //   为什么是"摘除"而不是"把开关关掉"：2026-11-10 已经用 `library/push-off` 把它关着，
    //   但整条链还挂着 —— 每 8 次工具调用仍会跑一次 `memoryList`（`limit: 0` = 全量扫库），
    //   推出来的东西又被开关丢掉。**耗 CPU 与 DB 读，产出一律作废。**
    //   历史留档：道 A 的源码在 `Updating/07-…/BACKUP/overlay/ours/recall-hints.js`（975 行，改前原件）。
    //
    //   道 B（压缩回放）**保留**：它的出口是 `ours/precompact.js` 的 `consumePlayback`，
    //   与道 A 从来不共用池（T-11 两池独立）。摘道 A 不动道 B 一行。
    //
    // ★★ 2026-11-14 同时改动：`output-containment` 从"只截断"升级为"先入库、后截断"。
    //   它需要的引擎口**必须惰性给**（本件挂载早于 `openTransport()`）——
    //   所以递的是闭包，调用时现取 `client`。引擎自愈后自动接上，不需要重挂。
    if (extras.outputContainment !== false)
        mountExtra('output-containment', () => installOutputContainment(ctx, {
            callEngine: async (args, signal) => {
                const c = client;
                if (c === undefined)
                    throw new Error('引擎未就绪（EngineClient 还没建好）');
                return c.callTool('ctx', args, signal ?? new AbortController().signal);
            },
            sessionIdOf: (exec) => exec?.session?.id ?? exec?.agent?.session?.id ?? '',
        }));
    // ★★ 2026-11-10 推送总开关（最小改动）：只给注入层一个开关文件的路径。
    //
    //   为什么只动这一处：两道推送（道 A【旧经验提醒】/ 道 B【压缩回放】）的**唯一出口**
    //   就是 `ours/session-memory.js` 的 `buildMemory` 里那两次取用。归档写库、
    //   `[archive]` 指针、`resume_snapshot` 导航都不走那条路 —— 所以"关推送"与
    //   "归档照写"天然不冲突，precompact / recall-hints 一行都不用改。
    //
    //   开/关 = 该文件在不在（不重启：每次渲染上下文都会 existsSync 一次）。
    //   路径用 storageDir 算，不写死 —— 写死的话换数据根后开关会按了没反应。
    setPushOffPath(join(resolved.storageDir, 'push-off'));
    if (extras.sessionMemory !== false)
        mountExtra('session-memory', () => installSessionMemory(ctx));
    if (extras.precompact !== false && resolved.precompact)
        mountExtra('precompact', () => installPrecompactArchive(ctx, () => client, { enabled: true }));
    if (extras.bundledSkills !== false) {
        const disabled = new Set(profile.disabledTools);
        const skills = ctx.get('skills', false);
        if (skills !== undefined) {
            mountExtra('bundled-skills', () => installBundledSkills(
                { ctx, register: entry => skills.register(entry), provider: name },
                disabled,
            ));
        }
    }

    // 工具计数提到 try 外面：catch 里要靠它判断"引擎该不该关"（见 catch 注释）。
    let toolCount = 0;

    try {
        // ---- 积木⑩：进程内引擎（1.0.0 唯一传输形态）----
        // ★ P4（沙箱归一，2026-11-04）：桥侧 guard（ours/sandbox-exec.js）已删。
        //   受限执行面进了引擎：createEngine({ctx}) 时引擎自己从 ctx 解析
        //   sandbox/sandboxPolicy 建 confiner（buildConfinerFromCtx，async+fail-closed），
        //   每次调用再把 exec.signal/session/callId 作 runtime 递下去 —— 逐会话解 policy。
        //   桥这边不再有任何"替引擎跑代码"的路径（by_tool 恒 0 的时代结束）。
        const bridge = await openTransport({
            ctx, resolved,
            // ★★ 2026-11-14（项目 07）：`seams.hintState` 现在**只报道 B**。
            //
            //   修前这里是"道 A 的 hintState() 与道 B 的 playbackState() 合并"——
            //   道 A 摘除后那个半边整个没了（`hints` 变量已删）。
            //   历史留档（道 A 在位时的两条教训，别丢）：
            //     · 2026-11-06 S9.44：`op:stats` 原来读引擎 `10-recall._state()`，而那个池
            //       在生产上**零调用方**（只有 15-hooks 和它自己的 selftest 用）⇒ seenA 恒 0 = 死数。
            //       修法是"生产真池由装配层注入"。这个机制**保留**，只是现在注入的池换成道 B。
            //     · 2026-11-09 M7：只递道 A 会让道 B 的遥测整段缺失，而且不报错。
            //       ⇒ 现在只递道 B，且 `op:stats` 的 `hintsSource` 文案必须跟着改成道 B 口径
            //       （见 `14-tools/index.js` 的 stats 分支，本轮已同步）。
            seams: {
                ...seams,
                hintState: seams.hintState ?? (() => ({ ...playbackState() })),
            },
        });
        client = bridge;
        const catalog = await bridge.listTools();

        // ---- 积木④：工具翻译 + 注册 ----
        const disabled = new Set(profile.disabledTools);
        // ★ P5：审批流编排器（宿主组了审批服务才有；没组则带申请=可读拒绝）。
        const escalate = createEscalator({ ctx, logger: ctx.logger });
        // 偏离记录（52 原版计 disposers 总数含附加模块）：此处单计工具数——日志语义准确。
        for (const tool of catalog) {
            if (disposed)
                return;
            if (disabled.has(tool.name))
                continue;
            try {
                disposers.push(tools.register(toDefinition(tool, {
                    callTool: (toolName, args, signal, meta) => bridge.callTool(toolName, args, signal, meta),
                    diagnose: (message) => ctx.logger.debug(`dsh-eco-context: ${message}`),
                    escalate,
                })));
                toolCount += 1;
            }
            catch (error) {
                ctx.logger.warn(`dsh-eco-context: skipped tool ${tool.name}: ${errorMessage(error)}`);
            }
        }

        // ---- 积木⑥：系统提示词注入（★ 装饰性功能：单独 try，失败绝不许拖累引擎）----
        // 2026-11-02 事故：routing.js 用了不存在的 order 键 → 这里抛 → 冒到下面的外层
        // catch → client?.shutdown() → 引擎关掉，但上面 11 个工具早已注册成功且不会撤下
        // → 每次调用都报 "EngineClient.callTool 在 initialize 之前被调用"。
        // 教训：**工具注册完成之后，任何"装饰层"失败都不许关引擎。**
        // 提示词段 / 归档指针 / 技能装载全属装饰层，坏了顶多少点提示，不该让工具变砖。
        let promptDegraded = false;
        if (disposers.length > 0) {
            const systemPrompt = ctx.get('systemPrompt', false);
            if (systemPrompt !== undefined) {
                try {
                    disposers.push(...installPromptSections({
                        ctx,
                        systemPrompt,
                        tools,
                        sandboxPolicy: ctx.get('sandboxPolicy', false),
                        archiveNotice,
                    }, {
                        precompact: extras.precompact !== false && resolved.precompact,
                    }));
                }
                catch (error) {
                    promptDegraded = true;
                    ctx.logger.warn(`dsh-eco-context: prompt sections unavailable, tools stay active (${errorMessage(error)})`);
                }
            }
        }

        ctx.logger.info(`dsh-eco-context: engine=${bridge.mode ?? 'inprocess'} registered ${toolCount} context-mode tools`
            + (promptDegraded ? ' (prompt sections degraded)' : ''));
    }
    catch (error) {
        // ★ 只有"一个工具都没注册成功"时才关引擎；已经注册出工具就保住引擎。
        // 关了引擎而工具还挂着的状态，比让插件整体失活更糟 —— 前者会让每一轮对话都报错。
        if (toolCount > 0) {
            ctx.logger.warn(`dsh-eco-context: bridge degraded after ${toolCount} tools registered; engine kept alive (${errorMessage(error)})`);
        }
        else {
            client?.shutdown();
            ctx.logger.warn(`dsh-eco-context: bridge unavailable; plugin is inactive (${errorMessage(error)})`);
        }
    }
}

/**
 * 打开传输通道：1.0.0 只有**进程内引擎**一种形态。
 *
 * ★ 2026-11-03：原先这里有三层判据（engineMode → 装配成功性 → 是否允许回退 child）。
 *   1.0.0 删掉了 vendor bundle 与 rpc.js，子进程路径已无路可退 ——
 *   回退分支`catch` 里那句"改 engineMode: auto 可退回子进程"是一句**指向不存在的承诺**。
 *   现在装配失败就是失败，错误原样抛出，由 apply() 的 catch 记日志。
 *
 * @param {object} p
 * @param {any} p.ctx
 * @param {ReturnType<typeof resolveConfig>} p.resolved
 * @param {object} p.seams
 * @returns {Promise<{start(): void, initialize(ms?: number): Promise<void>, listTools(ms?: number): Promise<any[]>, callTool(n: string, a: unknown, s?: AbortSignal): Promise<any>, shutdown(): void, mode: string}>}
 */
async function openTransport(p) {
    const { ctx, resolved, seams } = p;
    const diagnose = (message) => ctx.logger.debug(`dsh-eco-context: ${message}`);
    const engineRoot = seams.engineRoot ?? resolveEngineRoot(PLATFORM_DIR);
    // ★ 2026-11-05 Tool Switch（op:"switch"）：宿主侧实现**必须在构造时给**。
    //   为什么不能等 openTransport 返回后再挂：initialize() 里就 createEngine 装配完了，
    //   那时 createEngine 已经从 opts.toolSwitch 取过值 —— 事后再塞只会得到
    //   "引擎装好了但开关是 null"，也就是 op:switch 恒报 NO_HOST_CAP。
    //
    // ★★ 2026-11-06 修复（维护方 14:16 报"CTX 禁用的 pwsh 还在"）：**`stateFile` 必须传**。
    //   丢了它，`tool-switch.js` 里读与写两个 guard（`:176` / `:207`）会同时直接 return：
    //   读腿断 → `storageDir/tool-switch.json` 里的 `denied` 清单**从没被读进 denySet**
    //            → 装载时不补施加 → **pwsh 不关**；
    //   写腿断 → 关掉也**落不了盘** → 重启 DSH 又复原。
    //   证据：备份槽 B（11-06 05:06，重装前在跑的那份）的 `plugin.js` 是 18,879 B
    //        带这一行（sha `d46949c955`）；overlay 这份是 18,521 B（sha `fb0af3dc27`）不带 ——
    //        **358 字节的差恰好是这一行**。tool-switch.js 本身六处 hash 全同，没被动过。
    //   路径跟引擎库同一个 storageDir → 换会话/重启 DSH 之后仍然读得回那张清单
    //   （旧版写出的 `library/tool-switch.json` 正好落在这个位置，读回即生效）。
    const toolSwitch = seams.toolSwitch ?? createToolSwitch({
        ctx,
        logger: ctx.logger,
        stateFile: join(resolved.storageDir, 'tool-switch.json'),
    });
    // ★ 2026-11-05 后台作业（R17）：`ctx.jobs` 是宿主服务，引擎不认识 Cordis ——
    //   与 toolSwitch 同理，**必须在构造时给**（initialize() 里就装配完了）。
    //   宿主没装作业实现时返回 null，引擎据此给"我们没接"的可读拒绝（不是"宿主没有"）。
    const jobHost = seams.jobHost ?? createJobHost({ ctx, logger: ctx.logger });
    // ★★ 2026-11-14（项目 07）：道 A 摘除后，这条注释与来源都改成**道 B 口径**。
    //   原注释留档（2026-11-06 S9.44）：道 A 真实池的读口 —— `op:stats` 的 hints 行必须报真数；
    //   生产真正的道 A 实例是 `apply` 里 mountExtra('recall-hints') 建的那个，
    //   由 `apply` 通过 `seams.hintState` 递进来（本函数是模块级，拿不到 apply 的闭包）。
    //   现在生产池只有一个：`ours/precompact.js` 的 `playbackState()`（道 B 压缩回放），
    //   由 `apply` 的 `seams.hintState` 递进来。机制不变，换的只是池的维护方。
    const hintState = seams.hintState ?? (() => null);
    const client = new EngineClient({
        engineRoot,
        ctx,
        contentDir: resolved.storageDir,
        diagnose,
        toolSwitch,
        jobHost,
        hintState,
    });
    client.start();
    await client.initialize();
    client.mode = 'inprocess';
    return client;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
