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
 * 02-project/meta.js — 块元数据
 */
export const meta = {
    name: 'project',
    kind: 'impl',
    deps: ['core'],
    invariants: [
        'resolveContentDir 三态优先级 opts > env > 兜底，非绝对路径一律 throw',
        'isInside 词法+realpath 双闸；越界 throw DENIED_PATH（不返回 false）',
        'sha256 与 node:crypto createHash 完整节一致',
        'walkDirectoryDetailed 不跟随逃逸符号链接、不穿越环、maxFiles 截断报 capped',
    ],
};

export default meta;
