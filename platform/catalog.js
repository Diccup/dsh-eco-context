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
 * platform/catalog.js — 积木②：工具目录知识（引擎注册面的静态事实）。
 *
 * 归属：**自有**。这里只装"引擎到底注册了哪几个工具"这一类**静态事实**与
 * 由它派生的纯函数（模式注记）。不碰运行、不碰 ctx，可以在任何环境纯 import。
 *
 * 为什么单独一块：`FULL_CATALOG` 是运行时枚举出来的事实，
 * 换引擎时**唯一必须重新枚举并改这里的常量**——把它和注册循环放在一起，
 * 每次升级都得在 400 行里找到那三个数组；单独成块后升级只看这一屏。
 *
 * ★ 2026-11-03 换引擎（1.0.0 / 17 块积木）：工具面从 11 面**折叠成 2 面**。
 *   真源是 `engine/index.mjs` 的 `attachBridgeContract()`（注入 `module.REGISTERED_CTX_TOOLS`）。
 *   这里的常量必须与它一致 —— 安装脚本用 `--selftest` 的输出做对拍。
 *
 * ★ 这个文件住在 `overlay/platform/`，由 `engine/verify/assemble-release.mjs`
 *   **装配时覆盖**到 `releases/1.0.0/platform/`。不要手改成品 —— 下次 --force 会把它盖回去。
 */

/** 兜底禁用清单。1.0.0 只有 1 面，无需禁用任何工具。 */
export const DEFAULT_DISABLED_TOOLS = [];

/**
 * 引擎运行时注册面：1.0.0 实测 **1 面**（2026-11-04 设计确定：`ctx_run` 改名 `ctx`，
 *   `ctx_recall` 并入 op=recall —— "热路径不折叠"原案作废，实测一层 op 转译并不更贵）。
 *   来源：`engine/index.mjs` → `attachBridgeContract()` → `REGISTERED_CTX_TOOLS`
 *   `ctx` 是一个壳，**13 个 op**（run / recall / index / remember / pin / unpin /
 *   memory / stats / doctor / maint / purge / switch / list）从它的 `op` 参数分派，
 *   **它们不是独立工具位**，不要加回这个数组（加了会让 deployNote 算出不存在的工具）。
 *
 * ★★ 2026-11-09 ④步 CTX 净身（某次实测 独立核对抓出的实质残留，A 条）：
 *   原文这里是「13 个 op（run / **search** / recall / … / purge / list）」——
 *   **数目写 13、名单却有 14 个（含已迁走的 search、漏了 switch）**，自相矛盾。
 *   op:search 已随 FP 迁出，本条注释与下面 deployNote 的硬编码名单**必须与
 *   `engine/index.mjs` 的 OP_CATALOG 同源**，否则又是一条"教不存在的 op"。
 */
export const FULL_CATALOG = [
    'ctx',
];

/**
 * op 清单的**平台侧视图**（★ 2026-11-09 净身新增，修 某次实测 抓出的 A 条）。
 *
 * 为什么要有它：`deployNote()` 原来把 op 名单**硬编码在字符串里**，那是第二份真源 ——
 * op:search 迁走时**没人会想起来改它**（本轮就漏了，实测 某次实测 抓出）。
 * 教训同 `assemble-release` 的"维护一份本来可以算出来的清单 = 事故根源"。
 *
 * 为什么不直接 import `engine/index.mjs` 的 `OP_CATALOG`：
 *   本文件在 `platform/`（平台匹配层），而引擎在 `engine/` —— 平台层 import 引擎内部
 *   会**把分层倒过来**（G11⑩ 的 b 条守着"ours 不许反向 import 引擎"，平台层同理该守）。
 *   平台层拿到 op 清单的正规路径是**运行时由引擎注册面报上来**（`REGISTERED_CTX_TOOLS`
 *   / `engine.opCatalog`），不是静态 import。
 *   所以这里给的是**兜底常量**：仅当调用方拿不到运行时清单时才用；
 *   正常路径请把运行时清单传进来（见 deployNote 的 ops 形参）。
 *
 * ★ 保真纪律：改本数组时**必须**与 `engine/index.mjs` 的 `OP_CATALOG` 逐名对拍。
 *   `engine/verify/clean-split-check.mjs` 会把两者比一遍（它扫 platform/*.js）。
 */
export const KNOWN_OPS = [
    'run', 'recall', 'index', 'remember', 'pin', 'unpin',
    'memory', 'stats', 'doctor', 'maint', 'purge', 'switch', 'list',
];

/**
 * 独占型工具：不可并发（同一个库写入互斥）。
 *   `ctx` 里含 index / pin / unpin / remember / maint / purge 等写动作，
 *   所以它整体按独占处理（宁可保守，不要让两个写并发打同一个库）。
 */
export const EXCLUSIVE_CONTEXT_TOOLS = new Set(['ctx']);

/**
 * 部署注记：受限挂载时在主技能文档头部声明本形态可用的工具面。
 *
 * 为什么需要：SKILL.md 正文描述的是**全量目录**，而部署可能禁了工具。
 * 不声明的话模型会照文档路由到不存在的工具（S5.5 跨窗口复核 #1b 实测到的真问题）。
 * 无禁用 → 空串（零注入）。
 * ★ 2026-11-04 原名 modeNote（模式退役后改叫部署注记，逻辑不变）。
 *
 * ★★ 2026-11-09 ④步 CTX 净身（某次实测 核对 A 条）：原实现在 :60 把 op 名单**硬编码**
 *   在字符串里（`run / search / recall / … / purge / list`）—— 那是第二份真源，
 *   op:search 迁走时没人想起来改它 ⇒ **有工具被禁时，这段会把 op:search 教给模型**
 *   （一个已经不存在的 op）。现改为**形参 ops 传入 / 兜底用 KNOWN_OPS**，只此一份名单。
 *
 * @param {Set<string>} disabled - 已禁用工具集合
 * @param {string[]} [ops] - op 名单（建议传引擎运行时清单 `engine.opCatalog.map(o=>o.op)`；
 *                           省略则用 `KNOWN_OPS` 兜底）
 * @returns {string} 注记文本，空串表示无需声明
 */
export function deployNote(disabled, ops) {
    if (disabled.size === 0)
        return '';
    const mounted = FULL_CATALOG.filter(tool => !disabled.has(tool));
    const missing = FULL_CATALOG.filter(tool => disabled.has(tool));
    const list = (Array.isArray(ops) && ops.length > 0 ? ops : KNOWN_OPS).join(' / ');
    return [
        `> **Mode note:** only this ctx tool is mounted in this deployment: ${mounted.join(', ') || '(none)'}.`,
        `> Not mounted here: ${missing.join(', ') || '(none)'}.`,
        `> In 1.0.0 everything lives behind the ctx shell's op switch (${list}).`,
        '> Run commands and analyze files with ctx({op:"run",...}); recall from the local DB with ctx({op:"recall",queries:[...]}).',
    ].join('\n');
}

/**
 * 由禁用清单算出本形态挂载的工具面（日志与测试用）。
 * @param {Iterable<string>} disabled
 * @returns {string[]}
 */
export function mountedTools(disabled) {
    const set = disabled instanceof Set ? disabled : new Set(disabled);
    return FULL_CATALOG.filter(tool => !set.has(tool));
}
