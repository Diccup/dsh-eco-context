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
 * 13-sandbox/meta.js — 积木登记卡（registry.register 的 meta 形状）
 *
 * 干什么：告诉注册表这块叫什么、是什么 kind、依赖谁、有哪些不变量。
 * 为什么这样：`engine/registry.mjs` 只认 `{name, kind, deps}`；deps 里的名字必须在登记时已存在
 *            （只准往下依赖）。13-sandbox 只依赖 01-core（拿 EXEC_LANGUAGES / SCRIPT_EXT / DEFAULTS）。
 * 边界：纯数据，不含任何逻辑。
 */

import { INVARIANTS, NAME } from './index.js';

export const META = Object.freeze({
    name: NAME,
    kind: 'impl',
    deps: ['core'],
    invariants: INVARIANTS,
});

export default META;
