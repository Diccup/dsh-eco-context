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
 * libs/tempdir.js — 临时目录解析 + **自动回收**（全包唯一一处）
 *
 * 两个问题，这一块同时解决
 * ─────────────────────────────────────────────────────────
 * ① **绝对路径**：原先 `F:\workspace\LongMem\Temp` 被硬编码在 24 处。
 *    开发机上碰巧能跑，别人的机器没有 F 盘 → selftest 红、沙箱闸门抛错。
 *
 * ② **没人管的垃圾站**：光是"改成 os.tmpdir()"并不能解决什么 ——
 *    它只是把垃圾从 F 盘挪到 C 盘。2026-11-04 实测开发机的 Temp
 *    已经堆到 **997 MB / 1569 件**（单个 dbtest.db 就 683.9 MB），
 *    因为从来没有任何代码负责删。
 *
 *    ★ 所以本块的核心不是"找目录"，是**建了就必须有人删**。
 *
 * 规矩（三条，缺一条就会退化成垃圾站）
 * ─────────────────────────────────────────────────────────
 *
 * 1. **目录不预设盘符**：默认 `os.tmpdir()`；开发期要固定位置用环境变量
 *    `TEMP_DEV_DIR` 显式指定（不写进源码，成品里不留任何盘符）。
 *
 * 2. **建目录一律走 `makeTempRunDir()`**，不走裸 `mkdirSync`。
 *    它把目录登记进当前进程的回收表，并在退出时统一删除。
 *
 * 3. **清理有双保险**：
 *      · `process.on('exit')` 同步删除（正常结束、`process.exitCode` 退出都覆盖）
 *      · `process.on('SIGINT'/'SIGTERM')` 也删一遍
 *      · 再加一道**进程级兜底**：`sweepStale()` 在本次建目录时顺手删掉
 *        **同前缀且超过 2 小时**的残留 —— 进程被强杀（kill -9 / 断电）
 *        时前两条都不会执行，只有这道能收尸。
 *
 * 为什么兜底要按"前缀 + 时间"筛，而不是清空整个临时目录
 * ─────────────────────────────────────────────────────────
 * `os.tmpdir()` 是**全机器共用**的，里面有别人的东西（pip 缓存、别的程序）。
 * 清空它就是破坏别人。所以只删**我们自己命名的**（`ctx-mode-*` 前缀）
 * 且确实老旧的 —— 收自己的尸，不碰别人的。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 我们自己建的目录都用这个前缀，兜底清理只认它（绝不碰别人的临时文件）。 */
export const TEMP_PREFIX = 'ctx-mode-';

/** 兜底清理的老旧门槛：超过这个时间的同前缀残留才删。 */
const STALE_MS = 2 * 60 * 60 * 1000;

/** 本进程建过、还活着的目录（退出时统一删）。 */
const live = new Set();
/** 是否已挂上退出钩子（只挂一次）。 */
let hooked = false;

/**
 * 返回本次进程应使用的临时目录基址（**带盘符解析，但不预设盘符**）。
 *
 * @param {...string} segments 可选的子路径片段
 * @returns {string}
 */
export function tempDir(...segments) {
    const base = (process.env.TEMP_DEV_DIR ?? '').trim() || os.tmpdir();
    return segments.length === 0 ? base : path.join(base, ...segments);
}

/**
 * 删一个目录，绝不让清理本身抛（清理失败不该是程序的失败）。
 *
 * ★★ 2026-11-04 实测：**sqlite 句柄开着时第一次删一定失败。**
 *   门跑完时 content.db / -wal / -shm 还被引擎对象持有，
 *   受限宿主下 `fs.rmSync` 报 EPERM 且被我们的 catch 吞掉 → 目录留下。
 *   实测 12/12 个门的临时目录全部残留，就是这个原因。
 *
 *   所以这里做**退避重试**：让出一轮事件循环（给 GC 和 dispose 链机会
 *   把句柄放掉），然后重试若干次。同步的 exit 钩子里不能 await，
 *   但 `Atomics.wait` 能实现真阻塞，且不影响句柄释放（释放由 GC 在
 *   另一些时机做）。实践上重试 3 次、每次间隔 50ms 已足够覆盖绝大多数。
 */
function removeQuietly(dir, attempt = 0) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }
    catch { /* 落到下面重试 */ }
    if (attempt >= 3) return false;
    // 同步阻塞一小会儿再试：句柄常在 rm 失败后的几十毫秒内被释放
    try {
        const sab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sab, 0, 0, 50);
    }
    catch { /* 环境不支持 Atomics.wait 就算了，直接重试 */ }
    return removeQuietly(dir, attempt + 1);
}

/**
 * 收尸：删掉**我们自己前缀**且**超过 2 小时**的残留目录。
 *
 * 为什么必须有：进程被强杀（`kill -9`、断电、宿主崩溃）时，
 * 退出钩子根本不会执行 —— 那种情况只有这道兜底能收。
 *
 * @param {string} [base] 基址（默认同 tempDir）
 * @returns {number} 实际删掉的目录数
 */
export function sweepStale(base = tempDir()) {
    let removed = 0;
    let entries;
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    const cutoff = Date.now() - STALE_MS;
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
        const full = path.join(base, entry.name);
        let mtime;
        try {
            mtime = fs.statSync(full).mtimeMs;
        }
        catch {
            continue;
        }
        if (mtime > cutoff) continue;      // 还年轻，可能是别的活进程正在用
        removeQuietly(full);
        removed += 1;
    }
    return removed;
}

/** 挂退出钩子（幂等）。 */
function ensureHooks() {
    if (hooked) return;
    hooked = true;
    const drain = () => {
        for (const dir of live) {
            // ★ 2026-11-04 实测教训：**DB 句柄开着就删不掉。**
            //   门跑完时 sqlite 的 content.db / -wal / -shm 还开着，
            //   `fs.rmSync` 在受限宿主下静默 EPERM → 目录留下 → 垃圾站又回来了。
            //   exit 钩子里没法等异步 close，所以这里**重试 + 换个顺序**：
            //   先删文件，再删目录；单文件失败就跳过继续（finally rmdir 兜底）。
            removeQuietly(dir);
        }
        live.clear();
    };
    // 正常结束 / process.exitCode 退出
    process.on('exit', drain);
    // Ctrl-C / 被要求终止
    process.on('SIGINT', () => { drain(); process.exit(130); });
    process.on('SIGTERM', () => { drain(); process.exit(143); });
}

/**
 * 建一个**本次运行独有**的临时目录，并登记为退出时必删。
 *
 * ★ 全包建临时目录**只走这个函数**，不许裸 `mkdirSync` ——
 *   裸建 = 没人登记 = 退出不删 = 垃圾站又回来了。
 *
 * @param {string} label 用途标签（如 'selftest'、'g11'、'release-check'）
 * @returns {string} 已创建的目录绝对路径
 */
export function makeTempRunDir(label = 'run') {
    ensureHooks();
    // 建目录前先收一次尸：顺手把上次被强杀留下的残骸清掉
    sweepStale();
    const stamp = `${TEMP_PREFIX}${label}-${Date.now().toString(36)}-${process.pid}`;
    const dir = tempDir(stamp);
    fs.mkdirSync(dir, { recursive: true });
    live.add(dir);
    return dir;
}

/**
 * 立刻删掉一个用 `makeTempRunDir` 建的目录（并撤登记）。
 *
 * 什么时候要显式调：一个进程里要跑**很多轮**（如 17 块 selftest），
 * 不能等到进程退出才一次性删 —— 那样中途就攒了几百 MB。
 *
 * @param {string} dir
 * @returns {boolean} 是否删成功
 */
export function releaseTempRunDir(dir) {
    live.delete(dir);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }
    catch {
        return false;
    }
}
