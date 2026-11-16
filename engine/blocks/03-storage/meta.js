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
 * 03-storage/meta.js — 块元数据
 */
export const meta = {
    name: 'storage',
    kind: 'impl',
    deps: ['core', 'project'],
    invariants: [
        'S-3 基线只上 WAL/NORMAL/busy_timeout；autocheckpoint 默认；本轮不调 page_size/mmap/cache',
        '损坏 → 删 .db/-wal/-shm 重开一次；第二次仍损坏 throw SQLITE_CORRUPT（不静默）',
        'close 前 wal_checkpoint(TRUNCATE)，checkpoint 失败也照样 close（try/finally 语义）',
        'withRetry 只吞 BUSY，其它错误立刻上抛',
    ],
};

export default meta;
