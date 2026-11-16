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
 * platform/skill-set.js — 积木⑤：捆绑技能装载 + 部署注记注入。
 *
 * 归属：**自有**。技能文档是 52 带来的资产（内容已由我们迭代重写），
 * 但"怎么装进 DSH skills 服务"这一段现在独立成块。
 *
 * 关键行为（2026-11-04 起随工具面折叠改过）：
 *   1. **禁用判据 = 工具位 `ctx`**：1.0.0 只有 1 个工具位，所有能力都是它的 op。
 *      旧逻辑"技能名 ↔ 工具名"永远匹配不上新的禁用清单（清单里只可能有 'ctx'）
 *      —— 那等于禁用工具后技能文档照挂，引模型去调不存在的工具（S5.5 #1b 同族）。
 *      现在禁用 ctx = 撤下全部捆绑技能。
 *   2. **主技能要前置模式注记**：SKILL.md 正文描述全量目录，
 *      不声明模型就会照文档路由到不存在的工具。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployNote } from './catalog.js';
import { layout } from './layout.js';

/**
 * 随包技能清单。description/whenToUse 必须与 SKILL.md 头部一致（DSH 拿它做目录）。
 *
 * ★ 2026-11-05：技能名从旧的工具名（ctx-doctor / ctx-index / ctx-search /
 *   ctx-purge / ctx-stats / context-mode）改成 **`ctx` + `ctx-op-<op>`** 形态。
 *   理由：能力早就是 `ctx({op:"…"})`，技能名还挂着旧工具名，等于文档面与工具面
 *   两套命名，模型看见 `ctx-search` 会以为工具叫这个（口径不一的坑）。
 * ★ 2026-11-09（④步 CTX 净身）：摘掉 `ctx-op-search` 分片（6 → 5 分片）。
 *   op:search 整条迁 FP，技能目录也跟着走 —— ⑧b 门的判据是"技能名里的 op 必须在
 *   OP_CATALOG 里真实存在"，OP_CATALOG 摘了 search 行之后，留着 `ctx-op-search`
 *   目录就是**指着一个不存在的 op**（三方模拟：bad=[ctx-op-search]；同摘后 bad=0）。
 *   「清单只管挂载」的前提是清单里的东西真实存在；不存在的不是挂载，是陷阱。
 */
export const BUNDLED_SKILLS = [
    { name: 'ctx', description: 'ctx 工具总纲：13 个 op 速查、何时走 ctx 何时用原生工具、大输出规则。先读这一篇。', whenToUse: '开场或不确定该用 ctx 还是原生工具时。' },
    { name: 'ctx-op-run', description: 'ctx 的 run op：跑代码/命令/批量/后台作业；沙箱分工与标准流程。', whenToUse: '要跑命令、跑脚本、批量执行，或需要把大输出落盘再分析时。' },
    { name: 'ctx-op-recall', description: 'ctx 的 recall op：本地库三榜 RRF 召回，多问分节、命中续命。', whenToUse: '取回已入库的命令输出、已索引的文件片段、或压缩前的事实与决定时。' },
    { name: 'ctx-op-index', description: 'ctx 写入面：index 入 14 天临时库；remember/pin/unpin/memory 管长久库。', whenToUse: '要把内容留下来、要钉进长久库、或要管理长久记忆条目时。' },
    { name: 'ctx-op-stats', description: 'ctx 运维读面：stats 库现状（无节约率）、doctor 体检、maint 维护。', whenToUse: '要看库多大、做体检、清过期、优化或压缩时。' },
    { name: 'ctx-op-purge', description: 'ctx 的 purge op：显式清除 session/source/project，默认干跑。', whenToUse: '确实要删掉已入库内容时；先干跑看命中数。' },
];

/**
 * 装载捆绑技能。
 *
 * @param {object} host - DSH 宿主接缝（注入式，便于自测）
 * @param {{ get: (name: string, fallback?: false) => any, logger: { warn: (m: string) => void } }} host.ctx
 * @param {(entry: Record<string, unknown>) => () => void} host.register - skills.register
 * @param {string} host.provider - 技能 provider 名（=插件名）
 * @param {Set<string>} disabledTools - 已禁用的**工具名**
 * @param {string} [skillsDir] - 技能根目录，省略用包内默认
 * @returns {(() => void) | undefined} 卸载器；无 skills 服务或全失败时 undefined
 */
export function installBundledSkills(host, disabledTools, skillsDir = layout().skillsDir) {
    const entries = [];
    for (const skill of BUNDLED_SKILLS) {
        // ★ 2026-11-04：工具面只有 ctx —— 禁用它（或它不存在）时，捆绑技能
        //   全部撤下；否则模型会照 SKILL.md 去调已经折叠掉的旧名。
        if (disabledTools.has('ctx'))
            continue;
        try {
            const raw = readFileSync(join(skillsDir, skill.name, 'SKILL.md'), 'utf8');
            // 受限挂载时主技能头部注入部署注记（文档面与工具面对齐）；无禁用=原文完整。
            const content = skill.name === 'ctx' ? `${deployNote(disabledTools)}\n\n${raw}` : raw;
            entries.push({
                ...skill,
                path: `skills/${skill.name}/SKILL.md`,
                provider: host.provider,
                source: 'bundled',
                invocation: { modelInvocable: true, userInvocable: true },
                content,
            });
        }
        catch (error) {
            host.ctx.logger.warn(`dsh-eco-context: bundled skill unavailable (${skill.name}: ${error instanceof Error ? error.message : String(error)})`);
        }
    }
    if (entries.length === 0)
        return undefined;
    const disposers = entries.map(entry => host.register(entry));
    return () => disposers.forEach(dispose => dispose());
}
