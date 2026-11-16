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
 * platform/runtime.js — 积木⑦：配置默认值补全。
 *
 * 归属：**自有**。跟"这台机器上东西在哪"有关、跟插件业务无关，所以单独一块。
 *
 * ★ 沿革（三步收窄，每步都是"前提消失"不是"预防性删除"）：
 *   · 1.0.0：引擎进程内加载 → "解析 bundle 路径 / 组装子进程 env / 握手超时"作废删除；
 *   · 2026-11-04 P4 沙箱归一：桥侧 guard 删除 → `childNodeRuntime()` 没了使用方
 *     （受限执行进引擎，node 由 13-sandbox 的 runtime-probe 自己探）—— 留着就是
 *     01-core 探测之外的**第二份 node 发现**，删；
 *   · 同日：`pathKeyName()` 的引用面清零（活代码无人 import），删。
 *   现在只剩 `resolveConfig()` 一件：把用户配置补全成可执行形态。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析配置默认值（把用户配置补全成可执行形态）。
 *
 * ★ 1.0.0：`engineMode` / `serverPath` / `handshakeTimeoutMs` 三个键**删除**。
 *   · engineMode/serverPath → 1.0.0 只有进程内引擎，没有 bundle 也没有子进程，
 *     留着它们等于给用户一个指向不存在的开关；
 *   · handshakeTimeoutMs → 那是等 MCP 握手回帧的超时，进程内加载是 `await import()`，
 *     由宿主自身的加载耗时决定，没有可调窗口。
 *   同一事实在 Config（plugin.js）里也已同步删除，两处必须一致。
 *
 * ★ 2026-11-04：`mode` 键**退役**（vanilla 原版转接整条删除）。这里不再返回它；
 *   用户 yml 里残留的 mode 由 plugin.js 转给 loadDeployment 告警一次。
 *
 * @param {Record<string, unknown>} config
 * @param {string} [cwd]
 * @param {string} [home]
 * @returns {{ enabled: boolean, projectDir: string, storageDir: string, precompact: boolean, disabledTools: string[], legacyMode: unknown }}
 */
export function resolveConfig(config = {}, cwd = process.cwd(), home = homedir()) {
    return {
        enabled: config.enabled ?? true,
        projectDir: config.projectDir?.trim() || cwd,
        storageDir: config.storageDir?.trim() || join(home, '.dsh', 'context-mode'),
        precompact: config.precompact ?? true,
        disabledTools: config.disabledTools ?? [],
        legacyMode: config.mode,
    };
}
