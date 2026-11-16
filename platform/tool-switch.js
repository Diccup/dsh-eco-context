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
 * platform/tool-switch.js — 积木⑪：**工具开关（Tool Switch）—— 真关 / 真开**。
 *
 * 一句话：让模型把宿主工具**真的关掉**、**真的开回来** —— 全局生效、落盘持久，
 * 换会话照样关着、重启 DSH 也照样关着，直到再次显式 `action:"on"`。
 *
 * 归属：**自有**，且**必须住在 platform/**。理由和 engine-catalog 一样：
 * 「工具表长什么样」「怎么关一个工具」全是宿主知识，引擎是平台无关的纯库。
 * 引擎侧只拿到一个 `toolSwitch` 适配器对象（由 createEngine 注入），
 * 自己不认识 Cordis、不认识 ctx.tools —— 换宿主只换本文件。
 *
 * ═══════════════════════════════════════════════════════════
 * ★★ 从「只关当次会话」改成「全局 + 落盘」（2026-11-05）
 * ═══════════════════════════════════════════════════════════
 * 改之前只做了一半，两个洞都在这里补上：
 *
 *   ① **只关了当次会话**：旧写法把 deny 挂在 `exec.agent.ctx` 这一个作用域上。
 *      换一个对话 = 新的 agent + 新的 scope，而 `view(scope)` 只沿 **scope 链**
 *      （自己 + 祖先）算可见面 —— 新 scope 根本看不到旧 scope 的 layer，
 *      于是工具在别的对话里照样在（实测：本对话关了 pwsh，换个对话还在）。
 *   ② **重启即复原**：deny 登记表是进程内的 Map，进程一退就没了。
 *
 * 现在的两条腿：
 *
 *   · **全局**：关闭清单只有一处（本模块的 `denySet`），对**每个活着的 agent** 逐个施加，
 *     并在 `agent/created` 时给新 agent 自动补上 —— 新对话 / 子代理 / resume 全覆盖。
 *     为什么必须逐个：`restrict()` 只认 scoped context，拿全局 ctx 调用会直接抛
 *     `tools.restrict() requires a scoped context` —— 这是宿主硬约束，没有"一次调用关全局"。
 *   · **持久**：清单同时落盘（`stateFile`），插件装载时读回并立刻补施加；
 *     只有 `on` 才从盘上删。于是重启 DSH 之后它还是关着的。
 *
 * 恢复路径仍然只有 disposer 一条：restrict 是交集语义、不可逆，叠反 mask 只会越叠越窄。
 *
 * ═══════════════════════════════════════════════════════════
 * 为什么能做到"即时"（读源码得到的，不是猜的）
 * ═══════════════════════════════════════════════════════════
 * DSH 的工具面不是注册那一刻定死的，而是**每个请求现算**：
 *
 *   dsh-system-prompt/lib/index.js  assemble()
 *     → providers（dsh-tools 在 2802 行用 ctx.systemPrompt.tools() 挂的）
 *     → dsh-tools/lib/index.js:2932  wireSchemas(scope)
 *     → view(scope).visible ← **限制在每一轮重新投影一次**
 *
 * 所以 `restrict()` 改的是 layer，下一轮组 prompt 就看不到那个工具了 —— 零重启。
 * 反过来 `dispose()` 撤掉限制，下一轮又回来。
 *
 * ═══════════════════════════════════════════════════════════
 * 四条硬约束（踩了会自锁或报错，写在这里省得下次重新踩）
 * ═══════════════════════════════════════════════════════════
 * ① **restrict 只认 scoped context**：全局 ctx 调用会抛
 *    `tools.restrict() requires a scoped context`。本模块一律通过 `agent.ctx`
 *    （工具执行时拿到的那个 agent 作用域 / 逐个活 agent 自己的 ctx）去施加限制。
 *    cordis 的 service tracker 会把 `agentCtx.tools` 的 `this.ctx` 重绑到 agentCtx，
 *    于是 `restrict()` 读到的 scope 就是那个 agent —— 与 dsh-subagent 同一条路。
 *
 * ② **restrict 是交集语义、不可逆**：多个 mask 只会越叠越窄，放一个方向相反的
 *    allow 解不开。要恢复**只能**用它的返回值（disposer）撤。
 *    因此本模块维护 `tool → Map(agentId → disposer)` 登记表：off 存、on 撤、撤完删。
 *    **没有第二条恢复路径**，别去写"反 mask"。
 *
 * ③ **不能关掉自己**：把 `ctx` 关了，模型就再也调不到 switch 来开回去 —— 自锁。
 *    `run_code` 是 PTC 保留传输名，restrict 点名会直接抛。两者都拒。
 *
 * ④ **agent/created 的监听器不许抛**：那是 `ctx.serial` 分发的，抛出去会
 *    **让 agent 创建失败**。所以补施加一律 try/catch，失败只记 note（list 里能看到）。
 *
 * 边界：本模块不含任何业务判断（不猜"该关谁"），只做 列出/关/开 三个动作 + 真实状态回报。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 关掉会自锁或注定抛错的名字：禁止作为开关目标。 */
const PROTECTED = new Set(['ctx', 'run_code']);

/** 施加中的占位：防 tools/change 重入时对同一个 agent 叠第二层 mask。 */
const PENDING = Symbol('tool-switch/pending');

/**
 * 造一个工具开关适配器。
 *
 * @param {object} p
 * @param {any} p.ctx            插件上下文（用它的 logger / events / agents 服务）
 * @param {{warn?: (m: string) => void, info?: (m: string) => void, debug?: (m: string) => void}} [p.logger]
 * @param {string} [p.stateFile] 持久清单路径（缺省 = 只做进程内全局，不落盘）
 * @returns {{
 *   list: (exec: any) => Promise<object>,
 *   off:  (name: string, exec: any) => Promise<object>,
 *   on:   (name: string, exec: any) => Promise<object>,
 * }}
 */
export function createToolSwitch({ ctx, logger, stateFile } = {}) {
    const log = logger ?? ctx?.logger ?? {};

    /** 持久关闭清单（工具名）。全局唯一真源：内存与磁盘同一份。 */
    const denySet = new Set();
    /** 施加登记：tool → Map(agentId → disposer)。on 只能靠这些 disposer 恢复。 */
    const applied = new Map();
    /** 施加结果注记：tool → Map(agentId → state)，仅用于 list 说真话。 */
    const notes = new Map();
    /** tools/change 重放防抖。 */
    let replayQueued = false;

    /** @param {any} agent */
    const idOf = (agent) => String(agent?.id ?? agent?.session?.id ?? '');

    /** 当前活着的 agent 列表（拿不到就空数组，绝不抛）。 */
    function liveAgents() {
        try {
            const registry = typeof ctx?.get === 'function' ? ctx.get('agents', false) : undefined;
            const list = registry?.list?.();
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }

    /** @param {any} agent @returns {any} 这个 agent 作用域上的 tools 服务；没有就 undefined。 */
    function toolsOf(agent) {
        try {
            const tools = agent?.ctx?.tools;
            return tools !== undefined && tools !== null && typeof tools.restrict === 'function' ? tools : undefined;
        }
        catch {
            return undefined;
        }
    }

    /** @param {any} agent @param {any} tools */
    function viewOf(agent, tools) {
        try {
            return tools.view(agent);
        }
        catch {
            return undefined;
        }
    }

    /** @param {any} agent @param {any} tools */
    function modeOf(agent, tools) {
        try {
            return typeof tools.modeFor === 'function' ? String(tools.modeFor(agent)) : 'native';
        }
        catch {
            return 'native';
        }
    }

    /** 记一条施加结果（list 用）。 */
    function note(tool, agentId, state) {
        let map = notes.get(tool);
        if (map === undefined) {
            map = new Map();
            notes.set(tool, map);
        }
        map.set(agentId, state);
    }

    /** 生效会话数（state=off / off-elsewhere 都算"关着"）。 */
    function countScopes(tool) {
        const map = notes.get(tool);
        if (map === undefined)
            return 0;
        let n = 0;
        for (const state of map.values())
            if (state === 'off' || state === 'off-elsewhere')
                n += 1;
        return n;
    }

    // ── 持久化 ────────────────────────────────────────────────────────────

    /** 读回持久清单（文件不存在 = 空清单，不是错误）。 */
    function loadState() {
        if (typeof stateFile !== 'string' || stateFile.length === 0)
            return;
        let raw;
        try {
            raw = readFileSync(stateFile, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                log.warn?.(`dsh-eco-context: tool-switch state unreadable (${errorMessage(error)}); starting empty`);
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed?.denied) ? parsed.denied : [];
            for (const name of list) {
                const trimmed = String(name ?? '').trim();
                if (trimmed.length > 0 && !PROTECTED.has(trimmed))
                    denySet.add(trimmed);
            }
        }
        catch (error) {
            log.warn?.(`dsh-eco-context: tool-switch state is not valid JSON (${errorMessage(error)}); starting empty`);
        }
    }

    /**
     * 落盘。
     * 「写临时文件再改名」在 Windows 上会遇到 rename 不覆盖的老问题，而这里写的
     * 只是一份几十字节的清单 —— 直接整份覆盖，简单且不会留半份。
     */
    function saveState() {
        if (typeof stateFile !== 'string' || stateFile.length === 0)
            return;
        const body = JSON.stringify({
            version: 2,
            updatedAt: new Date().toISOString(),
            denied: [...denySet].sort(),
        }, null, 2);
        try {
            mkdirSync(dirname(stateFile), { recursive: true });
            writeFileSync(stateFile, body, 'utf8');
        }
        catch (error) {
            log.warn?.(`dsh-eco-context: tool-switch state not persisted (${errorMessage(error)})`);
        }
    }

    // ── 施加 / 撤销 ───────────────────────────────────────────────────────

    /**
     * 给一个 agent 施加一条 deny，返回**真实结果**（不是"我试过了"）：
     *   off              已压住（或本来就压着本模块的）
     *   off-elsewhere    这个 agent 上早就不可见，且不是本模块压的（on 也救不回来）
     *   not-restrictable 宿主不提供开关能力（PTC 保留传输名等）
     *   unknown          这个 agent 的工具面里没有它（还没注册 / 名字写错）
     *   no-tools         拿不到 tools 服务
     *   restrict-failed  宿主抛错（已回滚登记，不留半层）
     *
     * @param {any} agent
     * @param {string} tool
     * @returns {string}
     */
    function applyOne(agent, tool) {
        const agentId = idOf(agent);
        if (agentId.length === 0)
            return 'unknown';
        const tools = toolsOf(agent);
        if (tools === undefined) {
            note(tool, agentId, 'no-tools');
            return 'no-tools';
        }
        let map = applied.get(tool);
        if (map === undefined) {
            map = new Map();
            applied.set(tool, map);
        }
        if (map.has(agentId))
            return 'off';
        const view = viewOf(agent, tools);
        const restrictable = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set();
        const visible = view?.visible instanceof Map ? view.visible : new Map();
        if (!restrictable.has(tool)) {
            const state = visible.has(tool) ? 'not-restrictable' : 'unknown';
            note(tool, agentId, state);
            return state;
        }
        if (!visible.has(tool)) {
            // 已经不可见：分清是本模块关的（登记表里有）还是别处压着的
            note(tool, agentId, 'off-elsewhere');
            return 'off-elsewhere';
        }
        map.set(agentId, PENDING);
        let dispose;
        try {
            dispose = tools.restrict({ deny: [tool] });
        }
        catch (error) {
            map.delete(agentId);
            note(tool, agentId, 'restrict-failed');
            log.warn?.(`dsh-eco-context: tool "${tool}" restrict failed for agent ${agentId} (${errorMessage(error)})`);
            return 'restrict-failed';
        }
        map.set(agentId, dispose);
        note(tool, agentId, 'off');
        return 'off';
    }

    /** 把所有活着的 agent 都压一遍（新/旧/子代理一视同仁）。 */
    function applyAll(tool) {
        for (const agent of liveAgents())
            applyOne(agent, tool);
    }

    /** 撤销某工具在所有 agent 上的限制；返回成功撤掉的数量。 */
    function releaseAll(tool) {
        const map = applied.get(tool);
        if (map === undefined)
            return 0;
        let released = 0;
        for (const [agentId, dispose] of [...map]) {
            if (typeof dispose === 'function') {
                try {
                    dispose();
                    released += 1;
                }
                catch { /* 作用域已经没了：视为已撤 */ }
            }
            map.delete(agentId);
            note(tool, agentId, 'on');
        }
        applied.delete(tool);
        return released;
    }

    /** agent 被销毁：把它的登记擦掉（disposer 由宿主随 scope 一起收）。 */
    function forget(agent) {
        const agentId = idOf(agent);
        if (agentId.length === 0)
            return;
        for (const [tool, map] of [...applied]) {
            map.delete(agentId);
            if (map.size === 0)
                applied.delete(tool);
            notes.get(tool)?.delete(agentId);
        }
    }

    /**
     * 补施加（装载完成 / 工具面变化时用）。
     * 为什么不直接同步跑：`restrict()` 自己会触发 `tools/change`（宿主 onChange），
     * 同步重入会在同一个 agent 上叠第二层 mask —— 用微任务把重放推到本轮之外。
     */
    function queueReplay() {
        if (replayQueued || denySet.size === 0)
            return;
        replayQueued = true;
        queueMicrotask(() => {
            replayQueued = false;
            for (const tool of denySet)
                applyAll(tool);
        });
    }

    // ── 装配：读盘 + 补施加 + 挂事件 ─────────────────────────────────────

    loadState();
    // 插件可能在 agent 已经存在时才装载（HMR / 重启后 resume）：推到微任务里补一遍
    queueReplay();

    if (typeof ctx?.on === 'function') {
        // 新对话 / 子代理 / resume：一律自动补上 —— 这就是"换会话也关着"的那条腿
        ctx.on('agent/created', ({ agent } = {}) => {
            if (denySet.size === 0 || agent === undefined)
                return;
            for (const tool of denySet) {
                try {
                    applyOne(agent, tool);
                }
                catch (error) {
                    // ★ 约束④：这里抛出去会让 agent 创建失败，只能记
                    log.warn?.(`dsh-eco-context: tool "${tool}" not applied to new agent (${errorMessage(error)})`);
                }
            }
        });
        ctx.on('agent/disposed', ({ agent } = {}) => {
            if (agent !== undefined)
                forget(agent);
        });
        // 工具面变化（别的插件后注册 / preset 挂载完成）：把还没压上的补上
        ctx.on('tools/change', () => queueReplay());
    }

    // ── 对外三个动作 ─────────────────────────────────────────────────────

    return {
        /**
         * 列出：持久清单 + 本会话真实可见面 + 每个关闭项的实际生效范围。
         * @param {any} exec
         */
        async list(exec) {
            const agent = exec?.agent;
            const tools = toolsOf(agent);
            const agentId = idOf(agent);
            // 顺手补施加：HMR / 早于 agent 的装载路径靠这一句把老 agent 补上
            for (const tool of denySet)
                applyAll(tool);

            const lines = [];
            lines.push('工具开关（Tool Switch）· 真关 / 真开 · 全局 + 落盘持久');
            lines.push(denySet.size > 0
                ? `持久关闭（换会话、重启 DSH 都保持）：${[...denySet].sort().join(' · ')}`
                : '持久关闭：无（当前没有任何工具被本开关关着）');
            lines.push('');

            if (tools === undefined || agent === undefined) {
                lines.push('本会话拿不到 agent 作用域（子代理直派 / PTC 嵌套里可能没有），只能报清单。');
            }
            else {
                const view = viewOf(agent, tools);
                const visible = view?.visible instanceof Map ? view.visible : new Map();
                const known = view?.knownNames instanceof Set ? view.knownNames : new Set(visible.keys());
                const restrictable = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set();
                const rows = [...known].sort((a, b) => a.localeCompare(b)).map((name) => ({
                    name,
                    on: visible.has(name),
                    restrictable: restrictable.has(name),
                }));
                const onList = rows.filter((r) => r.on).map((r) => r.name);
                const offOurs = rows.filter((r) => !r.on && denySet.has(r.name)).map((r) => r.name);
                const offOther = rows.filter((r) => !r.on && !denySet.has(r.name)).map((r) => r.name);
                const locked = rows.filter((r) => !r.restrictable).map((r) => r.name);
                lines.push(`—— 本会话 agent=${agentId || '(未知)'} · 模式=${modeOf(agent, tools)}`);
                lines.push(`可见 ${onList.length} 个 / 本开关关着 ${offOurs.length} 个${offOther.length > 0 ? ` / 别处限制 ${offOther.length} 个` : ''}`);
                lines.push('');
                lines.push('开着的（可关）：' + (onList.length > 0 ? onList.join(' · ') : '(无)'));
                if (offOurs.length > 0)
                    lines.push('关着的（可开）：' + offOurs.join(' · '));
                if (offOther.length > 0)
                    lines.push('被其他限制关掉、本开关开不回来：' + offOther.join(' · '));
                if (locked.length > 0)
                    lines.push('不可开关（保留传输名等）：' + locked.join(' · '));
            }

            if (denySet.size > 0) {
                lines.push('');
                for (const tool of [...denySet].sort()) {
                    const map = notes.get(tool) ?? new Map();
                    const bad = [...map.entries()].filter(([, s]) => s !== 'off' && s !== 'off-elsewhere' && s !== 'on');
                    const badText = bad.length > 0
                        ? `；${bad.length} 个会话没压住（${bad.map(([id, s]) => `${id.slice(0, 22)}…=${s}`).join(', ')}）`
                        : '';
                    lines.push(`生效范围：${tool} → ${countScopes(tool)} 个会话已关${badText}`);
                }
            }

            lines.push('');
            lines.push('用法：action=off/on，tool=<名字>。off = 全局关并写盘（换会话/重启都保持）；on = 撤销并删盘（唯一恢复路径）。');
            return { result: { agentId, denied: [...denySet].sort() }, text: lines.join('\n') };
        },

        /**
         * 真关：写进持久清单 + 对所有活 agent（含本会话）施加 + 回读验证。
         * @param {string} name
         * @param {any} exec
         */
        async off(name, exec) {
            const tool = String(name ?? '').trim();
            if (tool.length === 0)
                throw fail('NO_INPUT', '要关哪个工具？给 tool=<工具名>；不带名字就先 action=list 看这张表。');
            if (PROTECTED.has(tool))
                throw fail('PROTECTED_TOOL', `"${tool}" 不能关：${tool === 'ctx' ? '关掉它模型就再也调不到 switch 开回来（自锁）' : '它是 PTC 保留传输名，restrict 点名会直接抛'}。`);
            const agent = exec?.agent;
            if (agent === undefined || agent === null)
                throw fail('NO_AGENT_SCOPE', '工具开关需要 agent 作用域：这次调用没有 exec.agent（子代理直派或 PTC 嵌套里可能没有）。请从正常对话轮里调。');
            const tools = toolsOf(agent);
            if (tools === undefined)
                throw fail('NO_TOOLS_SERVICE', '这台宿主没有 tools 服务（agent.ctx.tools 缺失），工具开关不可用。');
            const view = viewOf(agent, tools);
            if (view === undefined)
                throw fail('NO_TOOLS_VIEW', '宿主 tools 服务没有 view()，无法枚举可见工具面（DSH 版本对不上）。');
            const restrictable = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set();
            if (!restrictable.has(tool)) {
                const known = [...restrictable].sort().join(', ') || '(无)';
                throw fail('UNKNOWN_TOOL', `没有可开关的工具 "${tool}"。能开关的有：${known}`);
            }

            const already = denySet.has(tool);
            denySet.add(tool);
            saveState();
            applyAll(tool);
            applyOne(agent, tool); // 兜底：agents 服务不可用时至少压住调用方

            // 回读真值：native 模式下这一轮就应该看不见它了
            const after = viewOf(agent, tools);
            const stillVisible = after?.visible instanceof Map && after.visible.has(tool);
            if (stillVisible && modeOf(agent, tools) === 'native') {
                // 施加了但没生效 —— 不能谎报成功：回滚清单与限制
                if (!already) {
                    denySet.delete(tool);
                    saveState();
                }
                releaseAll(tool);
                throw fail('RESTRICT_NO_EFFECT', `对 "${tool}" 施加了限制但工具面没变化（宿主行为与预期不符）。已撤销这次限制。`);
            }

            const scope = countScopes(tool);
            log.info?.(`dsh-eco-context: tool "${tool}" switched OFF (global, persisted) for ${scope} agent(s)`);
            return {
                result: { tool, state: 'off', global: true, persisted: true, agents: scope },
                text: `已关闭 "${tool}"。**全局生效并写盘**：当前 ${scope} 个会话已收口，之后新开的对话/子代理也会自动关掉；重启 DSH 仍然保持。`
                    + `\n要开回来：ctx({op:"switch", action:"on", tool:"${tool}"})。`,
            };
        },

        /**
         * 真开：从持久清单删除 + 撤掉所有 agent 上的限制 + 回读验证。
         * @param {string} name
         * @param {any} exec
         */
        async on(name, exec) {
            const tool = String(name ?? '').trim();
            if (tool.length === 0)
                throw fail('NO_INPUT', '要开哪个工具？给 tool=<工具名>；不带名字就先 action=list 看这张表。');
            const agent = exec?.agent;
            const tools = toolsOf(agent);
            const ours = denySet.has(tool) || applied.has(tool);
            const released = releaseAll(tool);
            if (denySet.delete(tool))
                saveState();

            const visibleNow = (() => {
                if (tools === undefined || agent === undefined)
                    return undefined;
                const view = viewOf(agent, tools);
                return view?.visible instanceof Map ? view.visible.has(tool) : undefined;
            })();

            if (!ours) {
                if (visibleNow === true)
                    return { result: { tool, state: 'on', changed: false }, text: `"${tool}" 本来就是开着的，没动。` };
                throw fail('NOT_OURS_TO_RESTORE', `"${tool}" 现在是关的，但不是本开关关的（别的限制/配置压着），所以开不了 —— 只有自己关的才撤得掉。action=list 能看到哪些是本开关关的。`);
            }

            log.info?.(`dsh-eco-context: tool "${tool}" switched ON (global), released ${released} agent(s)`);
            return {
                result: { tool, state: 'on', changed: true, released },
                text: visibleNow === false
                    ? `已撤销对 "${tool}" 的限制（${released} 个会话），但它仍不可见 —— 还有别的限制压着它（不是本开关能解的）。action=list 看真实状态。`
                    : `已打开 "${tool}"：持久清单已清空该项，${released} 个会话的限制已撤销，下一轮起模型重新看到它（重启后也保持开着）。`,
            };
        },
    };
}

/** @param {string} code @param {string} message */
function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
