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
 * 12-lifecycle/meta.js — 块声明
 */
export const meta = {
    name: 'lifecycle',
    kind: 'impl',
    deps: ['core', 'project', 'store'],
    invariants: [
        '真删必须 dryRun:false 显式（默认只 plan）',
        '三表同判据同事务，删序 chunks → chunks_trigram → sources',
        '僵尸库判据先开库读 MAX(COALESCE(accessed_ts,indexed_at))',
        '.persistent.db 永不被目录扫描删',
        '完整性失败只报警不重建',
    ],
};
