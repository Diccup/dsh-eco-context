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
 * 04-store/meta.js — 块元数据
 */
export const meta = {
    name: 'store',
    kind: 'impl',
    deps: ['core', 'project', 'storage'],
    invariants: [
        '四表 DDL 只出自 libs/sql.js；两表列序逐位一致且 script_ngrams 为第 9 列（0-based）',
        'migrate 四态：ready 直通 / fresh 建表置 v1 / v0 有表 throw USER_VERSION_MISMATCH / v>认知 throw READ_ONLY_SCHEMA',
        '任何路径都不 DROP 既有表（静默删库红线）',
        '12 条查询模板每条恰含 1 个 bm25()，权重三元组出自 sql.js 唯一事实源',
    ],
};

export default meta;
