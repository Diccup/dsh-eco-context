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
 * platform/job-host.js — 积木⑫：**后台作业宿主适配器**（ctx 的 background 能力来源）。
 *
 * 一句话：把宿主 `ctx.jobs`（`@deepseek-ai/dsh-jobs` 的 JobRegistry）接给引擎，
 *        让 `ctx({op:"run", background:true})` 真的能开作业、真的能被 job_output 收回来。
 *
 * ═══════════════════════════════════════════════════════════
 * 为什么这文件必须住在 platform/
 * ═══════════════════════════════════════════════════════════
 * `ctx.jobs` 是 **Cordis 服务**，引擎是平台无关纯库（不认识 Cordis）。
 * 与 tool-switch / engine-catalog 同理：宿主知识留在平台层，引擎只拿一个
 * 形如 `{ start(job) }` 的适配器对象。
 *
 * ═══════════════════════════════════════════════════════════
 * 事故背景（2026-11-05，维护方的质问点）
 * ═══════════════════════════════════════════════════════════
 * 13-sandbox 原来在受限宿主下**无条件拒** background，文案写的是
 * 「受限宿主里后台跑没有作业体系可跟踪」——**这是假话**。宿主一直有
 * `@deepseek-ai/dsh-jobs` + `dsh-jobs-local` + `dsh-tool-jobs`（job_list /
 * job_output / job_kill 就在工具表里）。真实原因是**我们没接**。
 * 把自己的缺口讲成外部限制，是最坏的一类缺陷：它会让后来读代码的人
 * （包括实现方自己）照着一个错前提做设计。本文件就是把这条接上。
 *
 * ═══════════════════════════════════════════════════════════
 * 宿主契约（读 dsh-jobs-local/lib/index.js 得到，不是猜的）
 * ═══════════════════════════════════════════════════════════
 *   const id = jobs.start({
 *     kind: 'string',            // 非空；进 job id 前缀
 *     label: 'string',           // 非空；模型看到的一行
 *     owner: <agent>,            // 决定性：作业归属，谁收通知
 *     toolCall: {...},           // 可选：回指造成它的工具调用
 *     outputLimitBytes: number,  // 可选：正安全整数
 *     output: [source...],       // 可选：注册表代抽的拉取源
 *     run: (handle) => ({        // handle: { append(text, opts), updateProgress(line) }
 *       done: Promise<outcome>,  // outcome: { status, detail? }
 *       cancel: () => void,      // 作业被杀时被调
 *     }),
 *   })
 *
 * 关键一条：`start()` 会先问 `servesOwner(owner)`，**没装 dsh-tool-jobs 的组合会直接抛**
 * 「background jobs unavailable: no job controller serves this agent」。
 * 所以本适配器不假设它一定能用 —— 拿不到就返回 null，引擎照旧给可读拒绝，
 * 但拒绝的理由必须改成实话（"ctx 未接宿主作业服务"而不是"宿主没有"）。
 *
 * 边界：本文件不懂 sandbox、不懂 spawn、不懂 ctx op —— 只做
 *      「把一次后台执行登记成一个宿主作业」这一件事。
 */

/**
 * 造一个作业宿主适配器。
 *
 * @param {object} p
 * @param {any} p.ctx            插件上下文（只用 ctx.get / ctx.logger）
 * @param {{info?:Function, warn?:Function, debug?:Function}} [p.logger]
 * @returns {{
 *   start: (spec: {
 *     kind: string, label: string, owner: any, toolCall?: any,
 *     run: (handle: {append:(t:string,o?:any)=>void, updateProgress:(l:string)=>void}) =>
 *           ({ done: Promise<{status:string, detail?:string}>, cancel: () => void }),
 *   }) => string,
 *   available: true,
 * } | null} 宿主没组作业服务时返回 null（引擎据此给可读拒绝）
 */
export function createJobHost({ ctx, logger } = {}) {
    const log = logger ?? ctx?.logger ?? {};
    const jobs = ctx?.get?.('jobs', false);
    if (!jobs || typeof jobs.start !== 'function') {
        log.warn?.('dsh-eco-context: ctx.jobs 不可用 —— ctx 的后台执行（background:true）将被拒绝'
            + '（宿主未装载 @deepseek-ai/dsh-jobs 实现，如 dsh-jobs-local）');
        return null;
    }
    log.debug?.('dsh-eco-context: ctx.jobs 已接上 —— op:run 的 background:true 走宿主作业体系');

    return {
        available: true,

        /**
         * 登记一个后台作业。返回宿主作业 id（模型用 job_output 收它）。
         *
         * ★ 这里**不做 try/catch 吞错**：宿主抛的每一条都是有信息量的
         *   （并发上限 / 没有控制器 / 参数非法），吞掉就变成"看起来开了其实没开"。
         *   交回引擎，引擎把它变成模型能读的失败。
         */
        start(spec) {
            const { kind, label, owner, toolCall, run } = spec ?? {};
            return jobs.start({
                kind: String(kind ?? 'ctx'),
                label: String(label ?? 'ctx background run'),
                owner,
                ...toolCall === undefined ? {} : { toolCall },
                run,
            });
        },
    };
}
