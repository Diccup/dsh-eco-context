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
 * registry.mjs — 积木注册表（D2/D3 的中枢）
 *
 * 干什么：块注册自己（name/kind/deps/init/tools）；入口只问 registry 要东西。
 *        17 块里谁依赖谁写在这里一眼看全，块内不许跨块 import 实现文件。
 * 为什么这样：1.2.2 是"9 域 + 199 源片"的物理拼装，加一块要改构建脚本；
 *            2.0 是 17 块但完整节锁；我们要的第三种 —— 注册一行就能加能力（D3②）。
 * 边界：只做登记与查找，**不含任何业务逻辑**；块自己的初始化失败必须在这里可见（不吞）。
 */

import { createLogger } from './libs/log.js';

/** 块的 kind：决定它能被谁依赖（接口块 vs 实现块 vs 横切层）。 */
export const KINDS = Object.freeze(['contract', 'impl', 'crosscut', 'tool', 'entry']);

export function createRegistry(opts = {}) {
    const log = createLogger({ level: opts.level ?? 'info' }).forScope('registry');
    /** @type {Map<string, {name:string,kind:string,deps:string[],dir:string,block:object}>} */
    const blocks = new Map();
    /** @type {Map<string, {name:string, op:string, call:(a:object)=>Promise<any>|any}>} */
    const tools = new Map();
    const inited = [];

    /**
     * 登记一块。meta 形状 = { name, kind, deps:[], invariants:[] }。
     * deps 里的名字必须在登记时已存在 —— **只准往下依赖**（01-立项书 §4.2）。
     */
    function register(meta, block, dir) {
        const { name, kind, deps = [] } = meta ?? {};
        if (!name) throw new Error('registry.register(): meta.name 必填');
        if (!KINDS.includes(kind)) throw new Error(`registry.register(${name}): kind=${kind} 不在 ${KINDS.join('/')}`);
        if (blocks.has(name)) throw new Error(`registry.register(${name}): 重复登记`);
        for (const d of deps) {
            if (!blocks.has(d)) throw new Error(`registry.register(${name}): 依赖 ${d} 尚未登记（只准往下依赖）`);
        }
        blocks.set(name, { name, kind, deps, dir, block });
        log.debug(`登记 ${name}（${kind}）deps=[${deps.join(',')}]`);
    }

    /** 按登记顺序初始化（登记顺序天然就是拓扑序，因为有 deps 存在性检查）。 */
    async function initAll(ctx) {
        for (const { name, block, dir } of blocks.values()) {
            if (typeof block.init === 'function') {
                await block.init(ctx);
                inited.push(name);
            }
        }
        log.info(`已初始化 ${inited.length} 块：${inited.join(' ')}`, 'init-all');
        return inited.slice();
    }

    /** 登记一个工具面 op（14-tools 用；折叠后 ctx_run 真分派到这里）。 */
    function registerTool(op, entry) {
        if (tools.has(op)) throw new Error(`registry.registerTool(${op}): 重复`);
        tools.set(op, { op, ...entry });
    }

    /** 真分派：ctx_run 只做 entry.call(args)，不许在壳里 switch 复制业务。 */
    async function dispatch(op, args) {
        const entry = tools.get(op);
        if (!entry) throw new Error(`registry.dispatch(): 没有 op=${op}（可用：${[...tools.keys()].join(',')}）`);
        return entry.call(args ?? {});
    }

    /** 取一个 op 条目（bridgeCall / ctx_run 壳用；返回 undefined = 没这个 op）。 */
    function getOp(op) {
        return tools.get(op);
    }

    return {
        register,
        initAll,
        registerTool,
        dispatch,
        getOp,
        get: (n) => blocks.get(n)?.block,
        has: (n) => blocks.has(n),
        list: () => [...blocks.values()].map(({ name, kind, deps }) => ({ name, kind, deps: deps.slice() })),
        toolList: () => [...tools.values()].map(({ op, name, required, oneLine }) => ({ op, name, required, oneLine })),
        opCount: () => tools.size,
    };
}
