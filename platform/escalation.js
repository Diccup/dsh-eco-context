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
 * platform/escalation.js — 沙箱提权申请（P5，与宿主 pwsh 平权的审批流）
 *
 * 干什么：把模型带的 `sandbox_permissions + justification` 走宿主审批服务，
 *        批了就把批准的 mode 作为 policyOverride 交回调用链（仅本次调用生效）。
 * 为什么这样：宿主的这套编排长在 @deepseek-ai/dsh-sandbox 里，头注明言
 *        "shared by **every** sandbox-enforcing tool" —— pwsh/tool-fs 也只是调用方。
 *        但那个包在 app.asar 的宿主树里，插件位解析不到（实测 profile 的
 *        node_modules 只有 schemastery），**服务**能拿到（Cordis ctx.get），
 *        **函数**拿不到 —— 所以这里薄复刻编排（约 50 行），语义逐条对齐：
 *          · 两键必须成对（validateEscalationArgs 的判据与报错）；
 *          · 只许**严格更宽**（read-only < workspace-write < danger-full-access，
 *            这三级是宿主 runtime snapshot 公开语义，不是我们自定的）；
 *          · 一次一批（allowed-once 只喂本次调用，不持久扩权）；
 *          · 拒绝/取消/无通道的报错文案照 approveEscalation 原话（模型读得懂"停下解释，别绕路"）。
 *        漂移防护：模式表与服务接口都来自宿主，本文件不含任何"自定规则"；
 *        宿主若改了 outcome 词汇，四结局 default 分支会抛出来，不会静默放行。
 * 边界：不碰引擎（引擎保持平台无关，D1）；不知道 op 是什么 —— 它只处理"这次调用要升权"。
 */

/** 宽序（宿主 runtime snapshot 的三级公开语义）。 */
export const MODE_ORDER = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * 校验两键成对（照 dsh-sandbox validateEscalationArgs 的判据与报错措辞）。
 * @param {string|undefined} sandboxPermissions
 * @param {string|undefined} justification
 */
export function validateEscalationArgs(sandboxPermissions, justification) {
    if (sandboxPermissions !== undefined && justification === undefined)
        throw new Error('invalid escalation: sandbox_permissions requires a justification');
    if (justification !== undefined && sandboxPermissions === undefined)
        throw new Error('invalid escalation: justification is only valid together with sandbox_permissions');
}

/**
 * 造一个提权器。
 * @param {object} host - { ctx, logger }（注入式，可测）
 * @returns {((req:{requestedMode:string, justification:string, exec:object}) => Promise<string>) | undefined}
 *          宿主没组审批服务时返回 undefined（工具面上这两键还在，但调用会得到可读拒绝）。
 */
export function createEscalator(host) {
    const { ctx } = host;
    const policySvc = ctx.get('sandboxPolicy', false);
    if (!policySvc || typeof policySvc.resolve !== 'function')
        return undefined;
    // 审批服务的注册名以真机探测为准（候选表按宿主包名序试；探测结果进日志一次）。
    let approver = null;
    let approverName = null;
    for (const name of ['approval', 'userApproval', 'ApprovalService']) {
        const svc = ctx.get(name, false);
        if (svc && typeof svc.request === 'function') { approver = svc; approverName = name; break; }
    }
    ctx.logger?.debug?.(`dsh-eco-context: approval service probe: ${approver ? `found via "${approverName}"` : 'NOT FOUND (escalations will refuse readably)'}`);
    if (!approver)
        return undefined;

    return async function escalate({ requestedMode, justification, exec }) {
        validateEscalationArgs(requestedMode, justification);
        const agent = exec?.agent;
        if (!agent)
            throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but the call has no agent to route it through`);
        const standing = await policySvc.resolve(agent?.session ? { session: agent.session } : {});
        if (!standing || typeof standing.mode !== 'string')
            throw new Error('sandbox escalation: cannot resolve this session\'s current policy');
        if (requestedMode === standing.mode)
            return standing.mode;                       // 重复申请=直接放行（同 approveEscalation）
        if (MODE_ORDER.indexOf(requestedMode) <= MODE_ORDER.indexOf(standing.mode))
            throw new Error(`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${standing.mode}" mode`);
        const outcome = await approver.request({
            agent,
            toolName: 'ctx',
            callId: exec?.callId,
            reason: `escalate sandbox to ${requestedMode}: ${justification}`,
            displayReason: {
                en: `Allow this operation with ${requestedMode} permissions: ${justification}`,
                zh: `允许本次操作使用 ${requestedMode} 权限：${justification}`,
            },
            ...(exec?.signal ? { signal: exec.signal } : {}),
        });
        switch (outcome) {
            case 'allowed-once': return requestedMode;  // 一次一批
            case 'rejected':
                throw new Error(`the user rejected escalating this program to "${requestedMode}"; it stays denied, so stop and explain instead of working around it`);
            case 'cancelled':
                throw new Error(`approval for escalating to "${requestedMode}" was cancelled`);
            case 'unavailable':
                throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`);
            default:
                throw new Error(`unknown approval outcome: ${String(outcome)}`);
        }
    };
}
