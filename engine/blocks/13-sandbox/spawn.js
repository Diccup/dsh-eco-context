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
 * 13-sandbox/spawn.js — 唯一的进程启动路径
 *
 * 干什么：argv 直启一个子进程，收 stdout/stderr，管超时、杀进程树、输出封顶、后台启动。
 * 为什么这样：移植自 `engine/ref/current-engine/executor.js` 的 `#spawn`（只读基线）
 *            + 2.0 `b04-sandbox/spawn.ts` 的 `runProcess`。两者的分歧按 01-立项书 §六 判：
 *            **1.2.2 的超时/后台/杀树/封顶逻辑赢**（2.0 把超时判据上移到工具层，我们既要自测又要独立跑）。
 * 边界：只 spawn、只收流；不认识 ctx、不写库。
 *
 * ★ 本机实测（2026-11-03）：DSH 工具沙箱的令牌**不给匿名管道**，
 *   `spawn(..., stdio:'pipe')` → EPERM；`stdio:'ignore'` → OK。
 *   这是宿主限制，不是本块的 bug —— 生产路径（宿主主进程加载插件）不受限。
 *
 * ★★ R11（2026-11-05 维护方质疑 + 实测）：**匿名管道被拒 ≠ 拿不到输出**。
 *   受限令牌只是不给「匿名管道」，给的是**普通文件句柄**。实测：
 *     spawn(cmd, { stdio:['ignore', fdOut, fdErr] })  →  成功，输出完整落进文件
 *   （pwsh / node 子进程都验过，退出码与输出一字不差）。
 *   所以这里改成两级：**先按匿名管道起（生产路径不变，行为零变化）**；
 *   只有当 spawn 明确抛 `EPERM` 时，才**自动降级**为「文件重定向」再起一次。
 *   降级后 stdout/stderr 在进程结束后从临时文件读回，形状与管道路径完全一致，
 *   调用方（13-sandbox / 14-tools）**不需要知道走的是哪条路**。
 *   这样 `HOST_PIPE_DENIED` 从"常态错误"退回"两次都起不来才报"的真异常。
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = () => process.platform === 'win32';

/** 默认输出硬封顶 100MB（1.2.2 现值）：`yes` / `cat /dev/urandom | base64` 那种无限输出
 *  必须在内存里被掐住，而不是等超时。 */
export const DEFAULT_HARD_CAP_BYTES = 100 * 1024 * 1024;

/**
 * 杀树。**三级降级**，每级都实测过（2026-11-05）：
 *
 *  ① `proc.kill()` —— **首选，且唯一在受限令牌下保证有效的一级**。
 *     实测：受限令牌里 `taskkill` 是外部进程，低完整性级杀不动别人（`Access denied`，status=1）；
 *     但 `proc.kill()` 走的是我们自己持有的进程句柄，**杀自己起的子进程一律成功**。
 *  ② Windows：`taskkill /F /T` —— 补杀**孙进程**（`proc.kill` 只杀直接子进程）。
 *     受限沙箱里它多半失败（Access denied），所以只当**尽力而为**，失败绝不抛。
 *  ③ POSIX：杀整个进程组（`detached` 建的新组）。
 *
 * ★ R11 教训：原来只靠 `taskkill`，受限令牌下**一次都没杀成**，
 *   表现是"设了 1.5s 超时却跑了 60s"——超时形同虚设。这条现在有实测钉着。
 */
export function killTree(proc) {
    const pid = proc?.pid;
    if (!pid) return;

    // ① 直接杀我们持有的进程句柄（受限令牌下唯一可靠的一级）
    try { proc.kill('SIGKILL'); }
    catch { try { proc.kill(); } catch { /* 已经死了 */ } }

    if (isWin()) {
        // ② 补杀孙进程：taskkill 在受限令牌里常失败，失败即忽略，绝不抛给调用方
        try {
            execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        }
        catch { /* 受限沙箱里 Access denied 是常态；①已把直接子进程杀掉 */ }
        return;
    }
    // ③ POSIX：负 pid = 整个进程组
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch { /* 已经死了 */ }
}

/**
 * 启动一个子进程并收结果。**永不 reject**：spawn 失败也 resolve 成结构化结果。
 *
 * @param {string[]} argv 第一项是可执行文件绝对路径
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeoutMs] 不传 = 不设超时（超时策略归调用方）
 * @param {AbortSignal} [opts.signal] ★ 2026-11-04（P1）：调用方取消 → 杀树、killed:'cancel'。
 *        真机事故链：guard 删除后取消只剩这一条路，engine-client 的 exec.signal 必须一路递到这里。
 * @param {number} [opts.hardCapBytes]
 * @param {number} [opts.captureCapBytes] ★ 捕获上限（超限**停收但继续排水**，进程照跑完）。
 *        与 hardCap 的分工：hardCap 防内存炸（超了杀进程），captureCap 防灌上下文（超了丢字节留标记）。
 * @param {boolean} [opts.background] 后台：立刻回 pid，流改成空转排水
 * @param {(chunk:Buffer)=>void} [opts.onStdout] 旁路观察（selftest 用，不参与返回值）
 * @returns {Promise<{stdout:string,stderr:string,exitCode:number|null,timedOut:boolean,killed:'timeout'|'cap'|'cancel'|null,pid:number|null,backgrounded:boolean,capped:boolean,captureCapped:boolean,error:string|null}>}
 */
export function runProcess(argv, opts = {}) {
    const {
        cwd,
        env = process.env,
        timeoutMs,
        hardCapBytes = DEFAULT_HARD_CAP_BYTES,
        captureCapBytes = 0,
        signal,
        background = false,
        onStdout,
    } = opts;

    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(argv[0], argv.slice(1), {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false, // 注入面：一律 argv 直启
                detached: !isWin(),
                windowsHide: isWin(), // 不起可见控制台窗口（#384）
            });
        }
        catch (err) {
            // ★★ R11：匿名管道被宿主令牌拒绝（EPERM）→ **自动降级为文件重定向**再起一次。
            //   受限沙箱只是不给匿名管道，普通文件句柄是给的（已实测）。
            //   降级只在 spawn 阶段抛 EPERM 时发生；生产路径永不进入这条分支，行为零变化。
            if (String(err?.code) === 'EPERM' && !background) {
                const r = spawnViaFiles(argv, { cwd, env, timeoutMs, hardCapBytes, captureCapBytes, signal, onStdout });
                resolve(r);
                return;
            }
            // 其它错误（坏 argv / Windows EINVAL / 非 EPERM）：如实回，不假装成功。
            resolve({
                stdout: '', stderr: String(err?.message ?? err), exitCode: null,
                timedOut: false, killed: null, pid: null, backgrounded: false,
                capped: false, captureCapped: false, error: String(err?.code ?? 'SPAWN_FAILED'),
                stdioMode: 'pipe',
            });
            return;
        }

        const stdoutChunks = [];
        const stderrChunks = [];
        let totalBytes = 0;
        let capturedBytes = 0;
        let capped = false;
        let captureCapped = false;
        let timedOut = false;
        let cancelled = false;
        let settled = false;

        const finish = (patch) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* 旧宿主没有 */ } }
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                exitCode: null,
                timedOut: false,
                killed: null,
                pid: proc.pid ?? null,
                backgrounded: false,
                capped,
                captureCapped,
                error: null,
                stdioMode: 'pipe',
                ...patch,
            });
        };

        // ── 超时：杀进程树 ──
        const timer = timeoutMs
            ? setTimeout(() => {
                if (settled) return;
                timedOut = true;
                killTree(proc);
            }, timeoutMs)
            : null;

        // ── 取消（P1 新增）：调用方 signal abort → 杀树，killed:'cancel' ──
        // 先判已取消再挂监听（2.0 seam 的同款顺序：撞进来时可能早就 abort 了）。
        const onAbort = () => {
            if (settled || killedSomething()) return;
            cancelled = true;
            killTree(proc);
        };
        const killedSomething = () => timedOut || cancelled || capped;
        if (signal?.aborted) onAbort();
        else if (signal) { try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* 非标准 signal */ } }

        // ── 后台：立刻回，流改空转排水（不关管道，否则子进程下一次写会 SIGPIPE 死掉）──
        if (background) {
            const drain = (stream) => {
                if (!stream) return;
                stream.removeAllListeners('data');
                stream.on('data', () => { });
            };
            drain(proc.stdout);
            drain(proc.stderr);
            proc.unref();
            finish({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                exitCode: 0,
                timedOut: true,
                killed: 'timeout',
                backgrounded: true,
            });
            return;
        }

        // ── 输出双帽：hardCap 防内存炸（超了杀），captureCap 防灌上下文（超了**停收继续排水**）──
        // captureCap 不杀进程是刻意的：受限宿主里 guard 四年就是这么收的（512KB），
        // 跑完但截走——脚本的副作用（写文件）照做，只有回给模型的字节被掐。
        const collect = (stream, target) => {
            stream?.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > hardCapBytes) {
                    if (!capped) {
                        capped = true;
                        killTree(proc);
                    }
                    return;
                }
                if (captureCapBytes > 0 && capturedBytes >= captureCapBytes) {
                    if (!captureCapped) captureCapped = true;
                    return; // 排水不留，进程照跑
                }
                capturedBytes += chunk.length;
                target.push(chunk);
                onStdout?.(chunk);
            });
        };
        collect(proc.stdout, stdoutChunks);
        collect(proc.stderr, stderrChunks);

        proc.on('close', (exitCode) => {
            let stderr = Buffer.concat(stderrChunks).toString('utf8');
            if (capped) stderr += `\n[output capped at ${Math.round(hardCapBytes / 1024 / 1024)}MB — process killed]`;
            if (captureCapped) stderr += `\n[capture stopped at ${Math.round(captureCapBytes / 1024)}KB — process ran to completion, later output dropped]`;
            finish({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr,
                exitCode: (timedOut || cancelled) ? 1 : (exitCode ?? 1),
                timedOut,
                killed: timedOut ? 'timeout' : (cancelled ? 'cancel' : (capped ? 'cap' : null)),
            });
        });

        proc.on('error', (err) => {
            finish({
                stdout: '',
                stderr: err?.message ?? String(err),
                exitCode: 1,
                timedOut: false,
                killed: null,
                error: String(err?.code ?? 'SPAWN_FAILED'),
            });
        });
    });
}

/**
 * ★★ R11：**文件重定向**版 runProcess —— 受限令牌下拿不到匿名管道时的降级路径。
 *
 * 原理：宿主令牌拒绝的是「匿名管道」这种内核对象，普通文件句柄不受限。
 *      把子进程的 stdout/stderr 直接绑到两个临时文件上，进程照常跑、输出照常落盘，
 *      结束后读回内存，**返回形状与 runProcess 完全一致**（调用方无感）。
 *
 * 与管道路径的差异（都记在这，别让下一个维护者踩）：
 *   · 输出不是流式到达，是**进程结束后一次性读**（onStdout 仍在读回时分片回调，保持一致）；
 *   · `background` 不走这条路（后台要的是"立刻回、流空转排水"，文件模式没有流可排）；
 *   · 超时杀树照旧用 taskkill /F /T（与主路径共用 killTree）；
 *   · captureCap/hardCap 在读回阶段按**字节**施加（无法像管道那样提前掐断写入，
 *     但超上限时同样杀进程 + 补标记，语义对齐）；
 *   · 临时文件在**本函数内**建、读完即删，不残留在宿主 temp。
 *
 * @returns {Promise<object>} 与 runProcess 相同的结构，额外带 `stdioMode:'file'`。
 */
function spawnViaFiles(argv, opts = {}) {
    const { cwd, env = process.env, timeoutMs, hardCapBytes = DEFAULT_HARD_CAP_BYTES, captureCapBytes = 0, signal, onStdout } = opts;
    return new Promise((resolve) => {
        let dir = null;
        let fdOut = null;
        let fdErr = null;
        let proc = null;
        let settled = false;
        let timedOut = false;
        let cancelled = false;

        const cleanup = () => {
            for (const fd of [fdOut, fdErr]) { if (fd !== null) { try { closeSync(fd); } catch { /* 已关 */ } } }
            if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch { /* OS 会回收 */ } }
        };

        const settle = (patch) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* 旧宿主没有 */ } }
            // 先读回再清理（清理会删掉文件）
            let stdout = '';
            let stderr = '';
            let readNote = '';
            try {
                if (dir) {
                    stdout = readFileSync(join(dir, 'o'), 'utf8');
                    stderr = readFileSync(join(dir, 'e'), 'utf8');
                }
            }
            catch (e) { readNote = `\n[file-stdio 读回失败：${e?.code ?? e}]`; }
            cleanup();

            // 上限：读回阶段施加（口径与管道一致：hardCap 杀、captureCap 截+标记）
            let outStr = stdout;
            let errStr = stderr;
            let capped = false;
            let captureCapped = false;
            const total = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
            if (total > hardCapBytes) {
                capped = true;
                const keep = Math.max(0, hardCapBytes - (errStr.length > 4096 ? 4096 : 0));
                outStr = truncateBytes(outStr, keep);
                errStr = errStr.slice(-4096);
            }
            if (captureCapBytes > 0 && Buffer.byteLength(outStr, 'utf8') > captureCapBytes) {
                captureCapped = true;
                outStr = truncateBytes(outStr, captureCapBytes);
            }
            if (capped) errStr += `\n[output capped at ${Math.round(hardCapBytes / 1024 / 1024)}MB — process killed]`;
            if (captureCapped) errStr += `\n[capture stopped at ${Math.round(captureCapBytes / 1024)}KB — process ran to completion, later output dropped]`;
            if (readNote) errStr += readNote;
            if (onStdout && outStr) { try { onStdout(Buffer.from(outStr, 'utf8')); } catch { /* 观察者不该影响结果 */ } }

            resolve({
                stdout: outStr,
                stderr: errStr,
                exitCode: 1,
                timedOut,
                killed: timedOut ? 'timeout' : (cancelled ? 'cancel' : null),
                pid: proc?.pid ?? null,
                backgrounded: false,
                capped,
                captureCapped,
                error: null,
                stdioMode: 'file',
                ...patch,
            });
        };

        try {
            dir = mkdtempSync(join(tmpdir(), 'ctx-file-stdio-'));
            writeFileSync(join(dir, 'o'), '');
            writeFileSync(join(dir, 'e'), '');
            fdOut = openSync(join(dir, 'o'), 'r+');
            fdErr = openSync(join(dir, 'e'), 'r+');
        }
        catch (e) {
            cleanup();
            resolve({
                stdout: '', stderr: '', exitCode: null, timedOut: false, killed: null, pid: null,
                backgrounded: false, capped: false, captureCapped: false,
                error: `FILE_STDIO_SETUP_FAILED:${e?.code ?? e}`, stdioMode: 'file',
            });
            return;
        }

        const timer = timeoutMs
            ? setTimeout(() => { if (!settled) { timedOut = true; killTree(proc); } }, timeoutMs)
            : null;
        const onAbort = () => { if (!settled) { cancelled = true; killTree(proc); } };
        if (signal?.aborted) onAbort();
        else if (signal) { try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* 非标准 */ } }

        try {
            proc = spawn(argv[0], argv.slice(1), {
                cwd, env, stdio: ['ignore', fdOut, fdErr], shell: false,
                detached: !isWin(), windowsHide: isWin(),
            });
        }
        catch (e) {
            // 文件模式也起不来 → 这才是真的 HOST_PIPE_DENIED（匿名管道 + 文件都失败）
            settle({
                stdout: '', stderr: String(e?.message ?? e), exitCode: null,
                error: String(e?.code ?? 'SPAWN_FAILED'), stdioMode: 'file',
            });
            return;
        }

        proc.on('close', (code) => { settle({ exitCode: (timedOut || cancelled) ? 1 : (code ?? 1) }); });
        proc.on('error', (err) => {
            settle({ stdout: '', stderr: err?.message ?? String(err), exitCode: 1, error: String(err?.code ?? 'SPAWN_FAILED'), stdioMode: 'file' });
        });
    });
}

/** 按 UTF-8 字节边界截断（不劈坏多字节字符）。 */
function truncateBytes(str, maxBytes) {
    if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
        else hi = mid - 1;
    }
    return str.slice(0, lo);
}

