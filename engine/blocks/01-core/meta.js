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
 * 01-core/meta.js — 块元数据（registry 登记用；index.mjs 装配时读这份）
 *
 * 形状 = { name, kind, deps, invariants }。deps 为空数组：core 在第 0 层，谁都不依赖。
 */
export const meta = {
    name: 'core',
    kind: 'contract',
    deps: [],
    invariants: [
        'DEFAULTS 每个值都是有限正数',
        'EXEC_LANGUAGES 恒为 12 个且不重复',
        'SCRIPT_EXT 覆盖 EXEC_LANGUAGES 全部 12 个键',
        'userVersionState 四态互斥且覆盖 v<0 / v=0 / v=1 / v>1',
    ],
};

export default meta;
