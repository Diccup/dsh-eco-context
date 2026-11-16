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
 * platform/engine-client.js — 积木⑩：进程内引擎客户端。
 *
 * 归属：**自有**。它是平台匹配层与引擎之间的**唯一接触面**。
 *
 * 为什么单独成块（而不是让 plugin.js 直接 import 引擎）
 * ─────────────────────────────────────────────────────────
 * `plugin.js` 对客户端只有五个用法：start / initialize / listTools / callTool / shutdown。
 * 把这五个方法收在这里，好处是**引擎接口变了只改这一个文件**，组装流程一行不动 ——
 * 这就是「换实现，不换契约」。
 *
 * 只有一种形态：**进程内**（engine/index.mjs 的 createEngine）
 *   · 零 IPC、零常驻子进程、零 bundle
 *   · 引擎崩溃会连带宿主，所以本类带自愈（_revive）
 *
 * ★ 2026-11-03：原先还有第二种形态 `child`（起 node <bundle> 走 MCP JSON-RPC）。
 *   1.0.0 删掉 vendor bundle 之后它已不可能工作，**整条删除**。
 *   本类保留 MCP 客户端的方法名只是历史惯性，行为上已完全本地化。
 *
 * 失败降级：装配任何一步失败（缺 engine/、入口 import 失败、依赖不满足…），
 * 本类**抛一个带原因的错误**，不在这里静默降级 ——
 * 静默降级会让"以为在用新引擎，其实什么都没装"这种事发生。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 定位 engine/ 目录。
 *   发布包   <pkg>/engine/         （index.mjs + registry.mjs + blocks/）
 *   开发区   Work/.../engine/
 *
 * ★ 2026-11-03 真机事故：判据原先是 `index.mjs + .build/server.js`。
 *   那是 **1.2.2engine 的编译产物形态**（它的 engine/ 下确实有 .build/）。
 *   1.0.0 的引擎是**纯源码**（index.mjs + registry.mjs + blocks/），没有 .build。
 *   于是这个函数对 1.0.0 的包**必抛** → 装配失败 → 工具一个都注册不上，
 *   插件静默失活（五道门全绿、装上去却一个工具都没有，根因就在这一行）。
 *
 *   判据改成"**能让入口跑起来的最小集**"：
 *     · 1.0.0：index.mjs + registry.mjs（blocks/ 由入口按清单自找，缺块会在自检里报）
 *     · 1.2.2：index.mjs + .build/server.js（兼容，排障时可能指回老包）
 *   两者都不满足才抛 —— 宁可报错，也不把错的目录交给 import()。
 *
 * @param {string} platformDir - platform/ 的绝对路径
 * @returns {string} engine/ 的绝对路径
 * @throws 找不到就抛（宁可不装，也不静默降级）
 */
export function resolveEngineRoot(platformDir) {
    const candidates = [
        join(platformDir, '..', 'engine'),          // 发布包 / 开发区同构
        join(platformDir, '..', '..', 'engine'),    // 若 platform 嵌深一层
    ];
    for (const dir of candidates) {
        if (!existsSync(join(dir, 'index.mjs')))
            continue;
        if (existsSync(join(dir, 'registry.mjs')))
            return dir;                            // 1.0.0 纯源码形态
        if (existsSync(join(dir, '.build', 'server.js')))
            return dir;                            // 1.2.2 编译形态（兼容）
    }
    throw new Error(
        'dsh-eco-context: engine/ not found (need index.mjs + registry.mjs, or index.mjs + .build/server.js); looked for '
        + candidates.map(d => join(d, 'index.mjs')).join(' | '),
    );
}

/**
 * 进程内引擎客户端（平台层与引擎之间的唯一接触面）。
 */
export class EngineClient {
    /**
     * @param {object} opts
     * @param {string} opts.engineRoot     engine/ 绝对路径
     * @param {object} opts.ctx            Cordis 上下文（引擎要 ctx.get('sandbox')）
     * @param {string} [opts.contentDir]   存储目录（CONTEXT_MODE_DIR）
     * @param {(msg: string) => void} [opts.diagnose]  诊断日志
     * @param {object} [opts.toolSwitch]  ★ 2026-11-05 Tool Switch：op:"switch" 的宿主侧实现。
     *        必须**构造时**传 —— initialize() 内部就 createEngine 装配完了，
     *        晚一步塞进来的话引擎那边拿到的是 null（op:switch 恒 NO_HOST_CAP）。
     * @param {object|null} [opts.jobHost] ★ 2026-11-05 后台作业（R17）：`ctx.jobs` 适配器。
     *        同样必须构造时传。宿主没组作业服务时为 null —— 引擎据此给
     *        "ctx 未接宿主作业服务"的可读拒绝（旧文案谎称"宿主没有作业体系"，已改）。
     */
    constructor({ engineRoot, ctx, contentDir, diagnose = () => { }, toolSwitch, jobHost, hintState }) {
        this.engineRoot = engineRoot;
        this.ctx = ctx;
        this.contentDir = contentDir;
        this.diagnose = diagnose;
        this.toolSwitch = toolSwitch;
        this.jobHost = jobHost;
        /**
         * ★ 2026-11-06 S9.44：道 A 的真实遥测口（`ours/recall-hints.js` 的 `hintState`）。
         * 必须**构造时**给 —— `initialize()` 里 createEngine 就装配完了，晚一步引擎拿到 null。
         * 为 null 时 `op:stats` 回退读引擎 `10-recall._state()`（那个池生产上零调用方）。
         */
        this.hintState = hintState;
        /** @type {Awaited<ReturnType<any>> | undefined} */
        this.engine = undefined;
        /** 正在重建中的 promise（并发合并用，防止多个工具同时重建出多份引擎） */
        this._reviving = undefined;
        this.started = false;
        /** 本次关掉了（可自愈）。plugin.js 的 catch 就是这么关的。 */
        this.shut = false;
        /** 彻底卸载（绝不复活）。插件 unload 时由 retire() 置位。 */
        this.retired = false;
    }

    /** 标记已启动。进程内加载无需 spawn，这里只维护状态位。 */
    start() {
        this.started = true;
    }

    /**
     * 加载引擎（首次装配入口，同时是自愈入口）。
     *
     * ★ 2026-11-02 关键契约：本方法必须**可重入**。它既是首次装配入口，
     * 也是自愈入口（见 _revive）。所以：
     *   · 已装载 → 直接返回（幂等）
     *   · 已 retire（this.retired）→ 抛，那是调用方明确要求卸载，不该偷偷复活
     *   · 其余情况 → 重新 import + createEngine
     * 并发保护：多个工具同时撞上"引擎没了"，只允许一个真正重建，其余等待同一个 promise。
     *
     * @param {number} [_timeoutMs]
     */
    async initialize(_timeoutMs) {
        if (this.engine !== undefined)
            return;
        // ★ 只挡 retired（真卸载），不挡 shut —— shutdown 可能是事故中被误关的，
        //   那正是自愈要修复的状态。详见 _revive 的注释。
        if (this.retired)
            throw new Error('EngineClient 已卸载');
        // 并发合并：重建中的 promise 只有一份
        if (this._reviving !== undefined)
            return this._reviving;
        this._reviving = (async () => {
            const entry = await import(pathToFileURL(join(this.engineRoot, 'index.mjs')).href);
            // ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-8/§三-15）：**web 注入链整段退役**。
            //   原文（已留底 BACKUP\overlay\platform\engine-client.js）：
            //     const web = await loadWebModule();
            //     this.engine = await entry.createEngine({ …, web,
            //         webUrl: new URL('../ours/web-search.js', import.meta.url).href, … });
            //   为什么必须退役：`ours/web-search.js` 随 op:search 迁 FP，CTX 成品里不再有这件，
            //   留着 `loadWebModule()` 就是启动即 ERR_MODULE_NOT_FOUND（比"某个 op 失败"更糟：
            //   整个插件失活）。同时 CTX 侧已无任何消费 `deps.web` 的 op
            //   （op:search 与 index{url} 双入口全迁走，§三-1/2），注入 web 已无消费方。
            //   连带退役（同批）：`webUrl` —— 它是给 ctx.md 的 `{{webSearchUrl}}` 占位符供值的，
            //   而那一行文案（原 L5 search 行）已在 §三-7 摘除，占位符不复存在 ⇒ 空转链。
            //   历史价值留档：2026-11-03 第四个真缺陷是"op:search 一直是死的"——
            //   14-tools 的 search/index 都要 deps.web，16-entry 注释说"DSH 侧由 16-entry 注入"，
            //   但真正装配引擎的是本文件，这里从来没传过 web ⇒ 工具表写着"搜网页/抓正文"、调用必失败。
            //   修法当时是"装配时把内置 web-search 模块注入"，现在这条路整体搬去 FP 了。
            //   覆盖转移账：CTX 侧"客户端自注入 web"回归随迁 FP，FP 须自建等价门（G11 ④b 同族）。
            this.engine = await entry.createEngine({
                ctx: this.ctx,
                contentDir: this.contentDir,
                verbose: false,
                // ★ 2026-11-05 Tool Switch：宿主侧开关实现随装配递给引擎。
                toolSwitch: this.toolSwitch ?? null,
                // ★ 2026-11-05 后台作业（R17）：宿主作业适配器同理随装配递给引擎。
                //   为 null 表示宿主没组作业服务 —— 引擎会如实说"未接"，不谎称"宿主没有"。
                jobHost: this.jobHost ?? null,
                // ★ 2026-11-06 S9.44：道 A 真实池的读口（op:stats 的 hints 行）。
                hintState: this.hintState ?? null,
            });
            this.shut = false;          // 重建成功 → 解除关闭标志，后续调用走热路径
            this.diagnose(`engine in-process: ${this.engine.toolNames.length} tools, `
                + `confinement=${this.engine.confinedExecution ? 'on' : 'off'}`);
        })();
        try {
            await this._reviving;
        }
        finally {
            this._reviving = undefined;
        }
    }

    /**
     * 自愈：引擎在别处被关掉（装饰层抛错触发 shutdown、宿主重载、装配中断…）时，
     * 下一次工具调用把它重新装配起来，而不是永久报错。
     *
     * 为什么必须有
     * ─────────────────────────────────────────────────────────
     * 工具注册是一次性的、不可撤销的：注册完就挂在宿主的工具表里。
     * 如果引擎被关掉而工具还挂着，之后每一轮都是"工具在，引擎没了"，
     * 每次调用都报错 —— 这是比"插件整体失活"更糟的状态（用户感知是"每轮都崩"）。
     * 自愈把这种情况拉回"下一次调用自动可用"。
     *
     * 「关掉」和「弃用」必须分开
     * ─────────────────────────────────────────────────────────
     * `shutdown()` 在事故现场被 plugin.js 的 catch 调用过 —— 那是**误关**，应当自愈。
     * 但插件真被卸载时也会调 shutdown()，那时不该再复活（会泄漏引擎和 DB 句柄）。
     * 区别靠 `retired` 标记：只有 `retire()`（plugin.js 的 ctx.effect 卸载路径）才置位。
     * 所以 shutdown 之后仍然可以自愈，retire 之后绝不复活。
     *
     * @returns {Promise<boolean>} 是否真的重建了（用于日志区分「热路径」和「自愈」）
     */
    async _revive() {
        if (this.retired)
            throw new Error('EngineClient 已卸载，不再自愈');
        const rebuilt = this.engine === undefined;
        await this.initialize();
        if (rebuilt)
            this.diagnose('engine self-healed (rebuilt after it had been shut down)');
        return rebuilt;
    }

    /**
     * 彻底弃用：之后任何调用都不再复活（插件卸载路径专用）。
     * 与 shutdown() 的区别：shutdown 是"这次关掉"（可自愈），retire 是"永不回来"。
     */
    retire() {
        this.retired = true;
        this.shutdown();
    }

    /**
     * 取工具目录：返回 `[{name, description, inputSchema}]`。
     *
     * 直接读引擎的注册表 —— 零往返、零超时。`engine-catalog.js` 只做形状翻译 + schema 纯化。
     * ★ 也走自愈：目录拉取失败同样是"引擎没了"的症状（与 callTool 同等对待）。
     */
    async listTools() {
        await this._revive();
        const { catalogFromEngine } = await import('./engine-catalog.js');
        return catalogFromEngine(this.engine.module.REGISTERED_CTX_TOOLS);
    }

    /**
     * 调一个工具。
     *
     * ★ 第一句就是自愈：引擎被误关之后，下一次调用应该自动可用，
     * 而不是永久报"在 initialize 之前被调用"。
     *
     * ★★ 2026-11-04 设计确定：工具面只剩 1 个名字 `ctx`（`ctx_run` 改名 +
     *   `ctx_recall` 并入 op=recall），**不留旧名兜底**。
     *   曾经这里有一个 `toOpCall()` 做「52 旧工具名 → op」的归一（2026-11-03
     *   第五个真缺陷的修法），因为 `ours/` 的增强按旧名字调引擎、整条功能
     *   静默失效。现在调用方（ours/ 的 5 处 + 平台层）已全部改成直接写
     *   `ctx` + `args.op`，归一层就是死代码 —— 按「已经没有的东西不留」删掉。
     *   历史教训仍然有效：**新增按名字调引擎的代码时，名字只有 `ctx`，
     *   能力走 op；写错名字不会报错，只会静默拿到 no such tool。**
     *
     * @param {string} name  只认 'ctx'（引擎内 call() 还认 op 名，那是内部路）
     * @param {unknown} args
     * @param {AbortSignal} [signal]  ★ P2（沙箱归一）：不再丢弃。exec.signal → 引擎
     *        → 13-sandbox 的 runProcess —— guard 已撤，这条就是取消子进程的唯一通道。
     * @param {object} [meta]  ★ P2：`{session, callId}`（宿主每次调用的执行上下文）。
     *        session 让引擎按**本会话**解沙箱 policy；callId 给审批流挂账（P5）。
     *        形状以真机 exec 快照为准（首次调用打一次日志），字段缺失就整体 undefined，
     *        引擎侧对 undefined 有兜底（用装配期根）。
     * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
     */
    async callTool(name, args, signal, meta) {
        await this._revive();
        return this.engine.call(name, args, {
            signal,
            session: meta?.session,
            callId: meta?.callId,
            // ★ 2026-11-06 断链修复：policyOverride 必须一路递到引擎。
            //   tool-def 审批批了以后把批准的 mode 放进 meta.policyOverride，
            //   但这一层的 runtime 白名单里漏了它 → 引擎收到的 runtime 无此键 →
            //   engine/index.mjs 的 `meta.policyOverride` 恒 undefined → 提权 mode 从没进引擎，
            //   引擎一直按会话原档跑 → 提权拿到的仍是 workspace-write 语义（写工作区外被拒）。
            //   症状：单次提权看似批准了，却完全没提升写权限。
            policyOverride: meta?.policyOverride,
            // ★ 2026-11-05 Tool Switch：agent 必须一路传到底（tool-def 递 → 这里 → 引擎 → op:switch）。
            //   它是 restrict 唯一合法的 scoped context 来源，断了就关不了/开不了。
            agent: meta?.agent,
        });
    }

    /** 关掉引擎（可自愈；永不复活请用 retire）。 */
    shutdown() {
        if (this.shut)
            return;
        this.shut = true;
        try {
            this.engine?.dispose();
        }
        catch (error) {
            this.diagnose(`engine dispose failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
        }
        this.engine = undefined;
    }
}

/**
 * ~~加载内置 web-search 模块（`op:search` / `index:url` 的实现）~~
 *
 * ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-15）：`loadWebModule()` **整件移除**。
 *   原文（已留底 BACKUP\overlay\platform\engine-client.js）：
 *     async function loadWebModule() {
 *         return import(new URL('../ours/web-search.js', import.meta.url).href);
 *     }
 *   为什么整件删而不留兜底：`ours/web-search.js` 已随 op:search 迁 FP，CTX 包里不存在这件；
 *   留一个"import 一个必然不存在的文件"的函数 = 留一颗随时引爆的雷（谁再调一次就崩）。
 *
 *   历史价值留档（这条注释本身就是要保下来的信息）：
 *   这条加载曾经**同时是 `fp/` 目录（PAGE 增强，52 件 Python）唯一的使用方**：
 *     web-search.js → fp-bridge.js → fp/fpwebsearch.py
 *   所以当时「增强要不要挪窝」的第一条结论是：**fp/ 与 deps/（pylibs）不是死重量，是这条链的底座**。
 *   ★ 但这个结论的**前提**是"CTX 有 search"。维护方 14:0x 裁决把前提抽掉了：
 *     「你CTX都不搜索留着给你生小的？」⇒ 链断了，底座就成死重 ⇒ `fp/` 与 `deps/`
 *     按净身版 §三-24 **乙态摘净**（CARRY_DIRS / pkg.files / release-check 目录清单三处同批）。
 *   ⇒ 连带关系（冷启动接手必看）：本函数是"fp/ 该不该留"的唯一论据来源，
 *     本函数一删，§三-24 的摘净就是自洽的了，不是随手删包体。
 */

