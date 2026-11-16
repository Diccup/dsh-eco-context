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
 * 13-sandbox/run-pool.js — 在飞上限的并发池
 *
 * 干什么：跑 N 个互相独立的活，同时在飞的最多 M 个；一个抛了不拖累别的；
 *        返回顺序按输入下标（不是完成顺序）。
 * 为什么这样：移植自 `engine/ref/current-engine/runPool.js`（只读基线，51 行）。
 *            它是全项目唯一的并发原语 —— 所有「跑 N 条独立操作、上限 M 并发」都走这里，
 *            不许再抄一份（01-立项书 §4.2 的教训）。
 * 边界：纯调度，不 spawn、不连库。
 */

import { cpus } from 'node:os';

/**
 * @param {Array<() => Promise<any>>} jobs
 * @param {{concurrency?:number, capByCpuCount?:boolean, onSettled?:Function}} [opts]
 * @returns {Promise<{settled:Array<{status:'fulfilled',value:any}|{status:'rejected',reason:any}>, effectiveConcurrency:number, capped:boolean}>}
 */
export async function runPool(jobs, opts = {}) {
    const { concurrency, capByCpuCount = false, onSettled } = opts;
    if (!Array.isArray(jobs) || jobs.length === 0) {
        return { settled: [], effectiveConcurrency: 0, capped: false };
    }
    const requested = Math.max(1, concurrency ?? 1);
    const cpuCap = capByCpuCount ? Math.max(1, cpus().length) : requested;
    const effectiveConcurrency = Math.min(requested, cpuCap, jobs.length);
    const capped = effectiveConcurrency < requested;
    const settled = new Array(jobs.length);
    let nextIdx = 0;

    async function worker() {
        while (true) {
            const idx = nextIdx++;
            if (idx >= jobs.length) return;
            try {
                const value = await jobs[idx]();
                settled[idx] = { status: 'fulfilled', value };
            }
            catch (err) {
                settled[idx] = { status: 'rejected', reason: err };
            }
            onSettled?.(idx, settled[idx]);
        }
    }

    const workers = [];
    for (let w = 0; w < effectiveConcurrency; w++) workers.push(worker());
    // allSettled 兜底：worker 自己已经吞了错，这里再防一次 promise 逃逸
    await Promise.allSettled(workers);
    return { settled, effectiveConcurrency, capped };
}
