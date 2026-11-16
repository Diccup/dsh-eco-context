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
 * platform/deployment.js — 部署配置读取（yml 的 disabledTools 追加）。
 *
 * ★ 原名 modes.js，2026-11-04 模式系统退役后随内容改名。
 * ★ 2026-11-04 设计确定：**vanilla（原版直通）整条删除**。它唯一的作用是
 *   "想体验原版时换一份配置" —— 在 1 工具面 + 文案真源 ctx.md 的现状下，
 *   两种模式拿到的工具与文案早已一致，这个开关成了零信息量的死配置，还要
 *   维护双清单与双模式测试。将来真要做"原版转接"，直接写一个独立桥挂上去
 *   引擎即可，不占本包资源。模式系统（bubble/vanilla/清单文件）一并退役，
 *   下面这份就是唯一形态：自有增强全开，部署只做 disabledTools 加法。
 */

import { DEFAULT_DISABLED_TOOLS } from './catalog.js';

export const PLUGIN_NAME = 'dsh-eco-context';

/**
 * 解析生效的部署形态。
 *
 * 并集语义保留（1.2.1 的教训仍然成立）：yml 的 disabledTools 是**加法**，
 * 与默认清单取并集，不许整体覆盖 —— 旧覆盖语义下部署条目会悄悄顶掉清单。
 *
 * @param {string[]} configDisabled - 部署级追加禁用（yml / Config）
 * @param {{ warn?: (message: string) => void }} [logger] - 未知配置键的告警出口
 * @param {Record<string, unknown>} [legacy] - 已退役的旧配置键（mode 等），只告警不生效
 * @returns {{ disabledTools: string[], extras: Record<string, boolean> }}
 */
export function loadDeployment(configDisabled = [], logger, legacy = {}) {
    if (legacy.mode !== undefined) {
        logger?.warn(`${PLUGIN_NAME}: 配置键 mode="${legacy.mode}" 已退役（原版转接整条删除）；该键不再有任何作用，可从 yml 删除`);
    }
    return {
        disabledTools: [...new Set([...DEFAULT_DISABLED_TOOLS, ...(configDisabled ?? [])])],
        // ★ cjkAdapt 随 adaptArguments 一起退役（2026-11-04 P5b）：那个桥侧铺开补丁的
        //   前提（第三方 /FTS5 不分中文）在自有引擎里不存在 —— 07-tokenize/gram 三榜原生处理。
        // ★★ 2026-11-14（项目 07）：`recallHints`（道 A）**整项退役**（说明：「把道A去掉，
        //   不要道A推送了」）。它原来在这里默认开，2026-11-10 起被 `push-off` 开关压着；
        //   现在连链路带开关位一起摘了 —— 留一个恒假的开关位只会让下一个人去翻
        //   "为什么 false 了没生效"。
        extras: { outputContainment: true, sessionMemory: true, precompact: true, bundledSkills: true },
    };
}
