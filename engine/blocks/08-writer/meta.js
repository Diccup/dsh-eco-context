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
 * 08-writer/meta.js — 块声明
 */
export const meta = {
    name: 'writer',
    kind: 'impl',
    deps: ['core', 'project', 'store', 'analyze', 'gram', 'tokenize'],
    invariants: [
        '同 label 整体替换，事务内先删后插',
        '替换后 accessed_ts 置 NULL',
        'content 空串回退读 path（#350）',
        '文件读取走 openSync+fstat+readFileSync(fd)（#442）',
    ],
};
