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
 * 13-sandbox/runtime-probe.js — 语言运行时探测（12 语言，一个不裁）
 *
 * 干什么：按 PATH 找出每种语言的可执行文件，给出 `{path, source}`；
 *        Windows 下挑一个**可用**的 shell；再按语言把「脚本文件路径」拼成 argv。
 * 为什么这样：移植自 `engine/ref/current-engine/runtime.js`（detectRuntimes / getAvailableLanguages /
 *            buildCommand，只读基线）+ 2.0 `b04-sandbox/runtimes.ts`（findRuntime 的 PATH 遍历法）。
 *            两者的区别我们按 01-立项书 §六 判了：**2.0 的 PATH 遍历赢**（不 spawn `where`、不认宿主 node），
 *            但 javascript 保留 execPath 兜底并显式标记（见下）。
 * 边界：纯探测 + 纯 argv 拼装，不 spawn 业务代码、不写文件。
 *
 * ★ 三条必须记住的本机事实（2026-11-03 实测；2026-11-04 真机验收补③）
 *   ① `where node` 在本机**全 MISS**：DSH 的 node 不在 PATH 上。
 *      所以 javascript 走「PATH 优先 → **DSH 受管 node**（还原 1.2.2 P3 `childNodeRuntime`：
 *      `~\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，source=dsh-managed）
 *      → execPath 兜底（source=execPath-fallback）」，每次兜底都 warn，**不许静默当正常**。
 *      真机教训：宿主 execPath 是 **Electron**（basename 不是 node/bun/deno），旧兜底直接被
 *      门槛拒了 → op:"run" javascript 报 RUNTIME_MISSING。受管这一环就是来补它的。
 *      其余 11 种严格 PATH，无例外。
 *   ② 本机 `python` 是 Windows Store 桩（`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`），
 *      `stat` 就 EACCES。探测失败一律算「未安装」，**不是异常**（try/catch 吞掉，绝不上抛）。
 *   ③ ★ S9.42（2026-11-06 维护方提问「知道用 SHELL 了，为啥直接去 PYTHON」）**这条旧判断已作废**：
 *      原文是「受管 python 也在 `…\dependencies\python\python.exe`，但按①的白名单纪律
 *      **不自动兜底**（受限令牌下起不起得来只实测过 node）」—— 前提是"没实测过 python"。
 *      真机实测把前提推翻了：受限令牌下 `spawn(python.exe, ..., stdio:'pipe')` → EPERM，
 *      换成 `stdio:['ignore',fdOut,fdErr]`（spawn.js 的 R11 降级路径）→ **exit 0，输出完整**，
 *      与 node 处境完全相同；随包 python 3.12.14 还实测写出了中文文件。
 *      ⇒ python 现在**和 javascript 同等待遇**：PATH 优先 → 受管目录兜底（source=dsh-managed + warn）。
 *      不兜底的后果是实打实的：隔壁冷启动会话为了找一个已装好的 python，花了 **91.4 秒、5 次往返**
 *      （PATH 上那个 `python.exe` 是 WindowsApps 的 0 字节 App Execution Alias，实测 exit 9009）。
 *      其余 10 种语言仍严格 PATH，**一个都不加兜底**（没实测过的就是没实测过）。
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EXEC_LANGUAGES, SCRIPT_EXT } from '../01-core/index.js';

/** Windows 上 CreateProcess 能直接起的扩展名。`.bat/.cmd` 必须经 cmd.exe，扩展名为空的
 *  是 `#!/bin/sh` shim（pyenv-win 那类），Windows 上一律不当可直启运行时。 */
const WIN_STARTABLE_EXT = Object.freeze(['.exe', '.com']);
/** Windows PATHEXT 缺省值（2.0 contracts/constants.ts）。 */
const PATHEXT_DEFAULT = '.COM;.EXE;.BAT;.CMD';
/** 允许当 shell 的 basename（2.0 ALLOWED_SHELL_BASENAMES + cmd）。 */
const ALLOWED_SHELL_BASENAMES = /^(bash|sh|zsh|dash|pwsh|powershell|cmd|ksh|fish)(\.exe)?$/i;
/** bun 的 basename（决定 argv 是 `bun run file` 还是 `node file`）。 */
const BUN_BASENAME = /^bun(\.exe)?$/i;

/** 探测期告警出口；init() 会换成块自己的 logger。 */
let WARN = (m) => console.error(`[warn][sandbox] ${m}`);
export function setWarn(fn) { if (typeof fn === 'function') WARN = fn; }

const isWin = () => process.platform === 'win32';

function runtimeBasename(p) {
    const segs = String(p).split(/[\\/]/);
    return segs[segs.length - 1] ?? String(p);
}

/** PATH 条目：Windows 允许一对双引号包住一个目录，去掉它（2.0 path-entries.ts）。 */
function pathEntries(value, platform = process.platform) {
    const win = platform === 'win32';
    const delim = win ? ';' : ':';
    return String(value ?? '')
        .split(delim)
        .map((e) => (win && e.length >= 2 && e.startsWith('"') && e.endsWith('"') ? e.slice(1, -1) : e))
        .filter(Boolean);
}

/** Windows Store 桩目录：这里的 python.exe/bash.exe 是 App Execution Alias，不是真运行时。 */
function isStoreStub(p) {
    return /\\microsoft\\windowsapps\\/i.test(String(p).replace(/\//g, '\\'));
}

/** Git Bash / MSYS / hermes 自带 bash —— 受限令牌下必死 0xC0000022，一律拒绝（01-立项书 §六①）。 */
function isGitBash(p) {
    const lower = String(p).toLowerCase().replace(/\//g, '\\');
    return /\\mingw/.test(lower) ||
        /\\hermes\\/.test(lower) ||
        /\\usr\\bin\\bash\.exe$/.test(lower) ||
        /\\bin\\bash\.exe$/.test(lower) ||
        /\\git\\/.test(lower);
}

function isWindowsWslBash(p) {
    const lower = String(p).toLowerCase().replace(/\//g, '\\');
    return /\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(lower) ||
        /\\microsoft\\windowsapps\\bash\.exe$/.test(lower);
}

export function isAllowlistedShell(shellPath) {
    return ALLOWED_SHELL_BASENAMES.test(runtimeBasename(shellPath));
}

export function isBun(p) {
    return BUN_BASENAME.test(runtimeBasename(p));
}

/**
 * MSYS / MINGW / hermes 自带的运行时（perl、git 那套 shell 工具）。
 *
 * ★ R13（2026-11-05 实测）：**这些 exe 能被 stat 到，但在受限令牌下拉起来必崩。**
 *   实测 hermes 的 `perl.exe`：`stat` 成功 → 旧 isRunnable 判 `ok:true` →
 *   真跑时 `fatal error - couldn't create signal pipe, Win32 error 5`。
 *   这就是**假阳性**：`availableLanguages()` 告诉模型"perl 可用"，实际一用就死。
 *   与 isGitBash 同一个知识（代码里早就写着"受限令牌下必死 0xC0000022"），
 *   只是当初只应用在 bash 上，没应用到 perl 等其它 MSYS 程序。现在统一在这里拦。
 */
function isMsysRuntime(p) {
    const lower = String(p).toLowerCase().replace(/\//g, '\\');
    return /\\mingw/.test(lower) ||
        /\\hermes\\.*\\usr\\bin\\/.test(lower) ||
        /\\msys/.test(lower) ||
        /\\git\\.*\\usr\\bin\\/.test(lower);
}

/**
 * 单个候选是否「能跑」。
 * **探测失败 = 未安装，不是异常**：`stat` 抛 EACCES（Store 桩）/ ENOENT 一律吞掉返回 false。
 */
function isRunnable(full, { acceptExtensionless = false } = {}) {
    if (!full) return false;
    let st;
    try {
        st = statSync(full, { throwIfNoEntry: false });
    }
    catch {
        return false; // EACCES / EPERM / 未知 —— 按未安装处理
    }
    if (st === undefined || !st.isFile()) return false;
    if (isWin()) {
        const ext = path.extname(full).toLowerCase();
        if (ext === '') return Boolean(acceptExtensionless);
        if (!WIN_STARTABLE_EXT.includes(ext)) return false;
        // ★ R13：MSYS/MINGW 的 exe 在这里如实拒（不是"未安装"，是"受限令牌下起不来"）
        return !isMsysRuntime(full);
    }
    try {
        accessSync(full, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}

/** 每种语言的候选名，按查找顺序（Windows 带扩展名优先）。
 *
 * ★ R12（2026-11-05 实测）：**csharp 原来写 `csharp.exe`，Windows 上根本没有这个文件名** ——
 *   .NET 的真实宿主是 `dotnet.exe`。按旧表探测必然 MISS，于是"12 语言"里 csharp 永远报未安装。
 *   现在把 dotnet.exe 放最前（本机实测 `C:\Program Files\dotnet\dotnet.exe` 存在）。
 * ★ elixir 刻意**不加** `elixir.bat`：Windows 上 elixir 就是 .bat，而本文件的 WIN_STARTABLE_EXT
 *   只认 .exe/.com（.bat 必须经 cmd.exe 才能起，那是注入面）——所以即便 PATH 有也起不来。
 *   这是安全边界，不是漏配；加了等于放开注入面。
 */
function candidates(lang) {
    if (lang === 'shell') return isWin() ? [] : ['sh', 'bash'];
    if (lang === 'javascript') return isWin() ? ['node.exe', 'node', 'bun.exe', 'bun'] : ['node', 'bun'];
    if (lang === 'typescript') return isWin() ? ['bun.exe', 'bun', 'tsx.exe', 'tsx', 'ts-node.exe', 'ts-node'] : ['bun', 'tsx', 'ts-node'];
    if (lang === 'python') return isWin() ? ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3', 'py'] : ['python3', 'python'];
    if (lang === 'r') return isWin() ? ['rscript.exe', 'rscript', 'r.exe', 'r'] : ['Rscript', 'r'];
    // ★ R12：csharp 的真实宿主是 dotnet.exe（不是 csharp.exe）
    if (lang === 'csharp') return isWin() ? ['dotnet.exe', 'dotnet', 'csc.exe', 'csc'] : ['dotnet', 'csc'];
    const base = lang === 'rust' ? 'rustc' : lang;
    return isWin() ? [`${base}.exe`, base] : [base];
}

/**
 * 按 PATH 遍历找 `lang` 的可执行文件。返回 `{path, source}` 或 null。
 * `source`：`'path'`（正常）/ `'execPath-fallback'`（仅 javascript，见文件头 ★①）。
 *
 * Windows 规则（2.0 D-M2-R3-2）：整个 PATH 走完都没 `.exe/.com` 命中时，才退回第一个扩展名为空的 shim；
 * 但 shim 在 Windows 上不能被 CreateProcess 直启，所以我们**不返回 shim**，直接算未安装。
 */
export function findRuntime(lang, env = process.env) {
    if (lang === 'shell') return { path: resolveShellPath(), source: 'shell-resolution' };
    if (!EXEC_LANGUAGES.includes(lang)) return null;

    const dirs = pathEntries(env.PATH ?? '');
    const pathExt = isWin()
        ? String(env.PATHEXT ?? PATHEXT_DEFAULT).split(';').filter((e) => e !== '')
        : [];
    const names = candidates(lang);
    let shim = null;

    for (const dir of dirs) {
        for (const name of names) {
            const files = isWin() && path.extname(name) === ''
                ? [...pathExt.map((e) => name + e), name]
                : [name];
            for (const file of files) {
                const full = path.join(dir, file);
                if (isStoreStub(full)) continue; // Store 桩不是运行时
                if (!isRunnable(full)) continue;
                if (!isWin() || path.extname(full) !== '') return { path: full, source: 'path' };
                if (shim === null) shim = full;
            }
        }
    }
    // Windows 上的扩展名为空 shim：不直启（会走 shell，那是注入面）。
    return null;
}

/**
 * Windows 的 shell 选序（2026-11-05 维护方决定改：pwsh 优先，cmd 兜底）。
 *
 * 旧选序（2026-11-03）是「显式 SHELL > cmd.exe 默认，pwsh 必须显式指定」。改的理由是实测：
 *   · **编码**：cmd 是代码页 936(GBK)，而 13-sandbox 的 spawn 统一按 UTF-8 解码
 *     （`Buffer.concat(...).toString('utf8')`），中文路径打不开、中文输出全花 —— 实测
 *     `findstr "实现方"` 报「找不到文件」、`cd /d F:\workspace\彩票` 报「找不到指定路径」。
 *   · **pwsh 零乱码**：script-file.js 的 `buildPowerShellScriptContent()` 已经会加
 *     BOM + 三行 `[Console]::OutputEncoding` 前导，实测 pwsh 7.6.9 中文路径/中文输出全通。
 *   · **受限不受影响**：confine 对所有 argv 一视同仁（见 index.mjs buildConfinerFromCtx），
 *     三条实测（写工作区外→拒、写工作区内→通、起子进程→走同一枚受限令牌）与 cmd 完全一致。
 *     所以换 shell 只换语法与编码，不换令牌 —— 安全性没有回退。
 *
 * 新选序（Windows）：
 *   ① 显式 `SHELL`（allowlisted、存在、非 WSL、非 Git Bash）—— 用户说了算，最高优先
 *   ② **pwsh.exe（PowerShell 7）** —— PATH 优先，退标准安装位 `C:\Program Files\PowerShell\7\`
 *   ③ powershell.exe（Windows PowerShell 5.1）—— 同样带 BOM+UTF-8 前导
 *   ④ cmd.exe —— 最后的兜底（老机器没装 PS 时仍然能跑）
 *
 * ★ 为什么挂 R11 那条经验：受限令牌下**匿名管道不给、文件句柄给**，而 pwsh 与 node 都实测能起。
 *   1.2.2 时代"pwsh 可能受限"的怀疑已被本机实测否掉（写/读/起子进程三种都通过）。
 *
 * POSIX：`bash` > `sh`（不变）。
 */
export function resolveShellPath(env = process.env, log = () => {}) {
    if (!isWin()) {
        for (const name of ['bash', 'sh']) {
            const hit = findInPath(name, env);
            if (hit) { log(`shell: POSIX 选 ${hit}（${name} 在 PATH 上）`); return hit; }
        }
        log('shell: POSIX 无 bash/sh，返回 null');
        return null;
    }
    const userShell = env.SHELL;
    if (userShell && isAllowlistedShell(userShell) && !isWindowsWslBash(userShell) && !isGitBash(userShell)) {
        try {
            if (statSync(userShell, { throwIfNoEntry: false })?.isFile()) {
                log(`shell: 用显式 SHELL=${userShell}`);
                return userShell;
            }
        }
        catch { /* 落到默认 */ }
    }
    if (userShell && (isGitBash(userShell) || isWindowsWslBash(userShell))) {
        log(`shell: 拒绝 SHELL=${userShell}（Git Bash/WSL，受限令牌下不可用）`);
    }
    // ② pwsh 7：PATH 优先，再探标准安装位（PATH 上常常只有 5.1 的 powershell.exe）
    const pwsh = findInPath('pwsh.exe', env) ?? firstExistingFile([
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
        path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'PowerShell', 'pwsh.exe'),
    ]);
    if (pwsh) { log(`shell: Windows 选 pwsh=${pwsh}（中文路径/输出不过 GBK，2026-11-05 维护方决定）`); return pwsh; }
    // ③ Windows PowerShell 5.1：script-file.js 同样会加 BOM + UTF-8 前导
    const legacy = findInPath('powershell.exe', env) ?? firstExistingFile([
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    if (legacy) { log(`shell: 退回 Windows PowerShell 5.1=${legacy}（没装 pwsh 7）`); return legacy; }
    // ④ cmd.exe 兜底
    const cmd = findInPath('cmd.exe', env) ?? findInPath('cmd', env);
    if (cmd) { log('shell: 退回 cmd.exe（本机未见 pwsh/powershell；中文场景会受 GBK 影响）'); return cmd; }
    log('shell: 找不到任何 shell（pwsh/powershell/cmd 全无）');
    return null;
}

/** 按顺序取第一个存在且可执行的绝对路径（用于探测标准安装位，不依赖 PATH）。 */
function firstExistingFile(candidates) {
    for (const p of candidates) {
        try {
            if (isRunnable(p)) return p;
        }
        catch { /* 下一个 */ }
    }
    return null;
}

function findInPath(name, env = process.env) {
    if (!name) return null;
    for (const dir of pathEntries(env.PATH ?? '')) {
        const full = path.join(dir, name);
        if (isStoreStub(full)) continue;
        if (isRunnable(full)) return full;
    }
    return null;
}

/** 版本探测：失败一律 'unknown'，绝不上抛（探测不是业务，炸了就是bug）。 */
const versionCache = new Map();
export function getVersion(cmd, args = ['--version']) {
    if (!cmd) return 'unknown';
    const key = `${cmd}|${args.join(' ')}`;
    if (versionCache.has(key)) return versionCache.get(key);
    let out = 'unknown';
    try {
        // 直接 execFileSync 绝对路径，不用 shell（shell:true 是注入面）。
        const text = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, windowsHide: true })
            .trim().split(/\r?\n/)[0];
        if (text) out = text.slice(0, 120);
    }
    catch { /* 未安装 / 无 --version / 超时 —— 都是 'unknown' */ }
    versionCache.set(key, out);
    return out;
}

/**
 * 受管 node 解析（还原 1.2.2 P3 补丁 `childNodeRuntime` 的知识，2026-11-04 真机抓到）：
 * DSH 宿主进程 execPath 是 Electron（basename 不在 node/bun/deno 里 → execPath 兜底被拒），
 * PATH 上又没有 node → 老引擎靠这条链找到 `~\.dsh\dsh-runtimes\dsh-primary-runtime\
 * dependencies\node\bin\node.exe`。四条硬约束#1：**node 必须自己找，不能信 execPath**。
 * 从插件安装树向上爬 + DSH_HOME/~/.dsh 两条路，全部 existsSync 才算。
 */
const MANAGED_NODE_REL = ['dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin'];
const SHELLISH = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i;
function findManagedNode(startDir = import.meta.dirname, home = process.env.USERPROFILE || process.env.HOME) {
    const candidates = [];
    let acc = startDir;
    for (let depth = 0; depth < 10; depth += 1) {
        acc = path.dirname(acc);
        candidates.push(path.join(acc, ...MANAGED_NODE_REL));
    }
    if (home) candidates.push(path.join(home, '.dsh', ...MANAGED_NODE_REL));
    for (const dir of candidates) {
        const exe = isWin() ? path.join(dir, 'node.exe') : path.join(dir, 'node');
        try {
            if (statSync(exe, { throwIfNoEntry: false })?.isFile() && !SHELLISH.test(exe)) {
                return { dir, exe };
            }
        } catch { /* 继续爬 */ }
    }
    return null;
}

/**
 * ★ S9.42（2026-11-06）：受管 python 解析 —— 与 `findManagedNode` 同一套落点，**只服务 python**。
 *
 * 为什么要它（实测链，见开发日志 S9.42 §一）：
 *   · 本机 PATH 上的 `python.exe` 是 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`，
 *     `Length = 0` 的 App Execution Alias，`python --version` 实测 **exit 9009**（空输出）；
 *   · 真 python 在 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
 *     （实测 **3.12.14**，能跑、能写中文文件）；
 *   · 隔壁冷启动会话为了找它花了 91.4 秒 / 5 次往返 —— 而同一个包里的 `overlay/ours/python-find.js`
 *     本来就能找到（两套发现逻辑、两套答案，教训六十四）。
 *
 * 落点（与 ours/python-find.js 对齐，避免第三套实现再漂移）：
 *   ① 从插件树向上爬 10 层，拼 `dsh-runtimes\dsh-primary-runtime\dependencies\python`
 *   ② `DSH_HOME` / `~/.dsh` 下同一相对路径
 *   ③ `~/.dsh/dsh-runtimes/<任意版本>/dependencies/python`（primary 优先，其余按名字排，保证结果可复现）
 *
 * 纪律：**只给 python 用**。其余 10 种语言仍严格 PATH —— 没实测过就是不兜底。
 * @returns {{exe:string, source:string}|null}
 */
const MANAGED_PY_NEST = ['dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python'];
const PY_EXE = win => (win ? 'python.exe' : 'python3');
function findManagedPython(startDir = import.meta.dirname, home = process.env.USERPROFILE || process.env.HOME) {
    const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    const probe = (dir, source) => {
        for (const n of names) {
            const exe = path.join(dir, n);
            try {
                if (statSync(exe, { throwIfNoEntry: false })?.isFile() && !isStoreStub(exe)) {
                    return { exe, source };
                }
            } catch { /* 下一个 */ }
        }
        return null;
    };
    // ① 从插件树向上爬（受管 node 那条同款）
    let acc = startDir;
    for (let depth = 0; depth < 10; depth += 1) {
        acc = path.dirname(acc);
        const hit = probe(path.join(acc, ...MANAGED_PY_NEST), 'dsh-managed');
        if (hit) return hit;
    }
    // ② DSH_HOME / ~/.dsh
    if (home) {
        const hit = probe(path.join(home, '.dsh', ...MANAGED_PY_NEST), 'dsh-managed');
        if (hit) return hit;
    }
    const dshHome = process.env.DSH_HOME;
    if (dshHome) {
        const hit = probe(path.join(dshHome, ...MANAGED_PY_NEST.slice(1)), 'dsh-managed');
        if (hit) return hit;
    }
    // ③ dsh-runtimes 下任意版本目录（primary 优先）
    const root = home ? path.join(home, '.dsh', 'dsh-runtimes') : null;
    if (root) {
        let entries;
        try { entries = readdirSync(root, { withFileTypes: true }); }
        catch { return null; } // 没有这个目录 = 不是 DSH 环境，正常
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
            .sort((a, b) => (a.includes('primary') === b.includes('primary') ? a.localeCompare(b) : (a.includes('primary') ? -1 : 1)));
        for (const name of dirs) {
            const hit = probe(path.join(root, name, 'dependencies', 'python'), 'dsh-managed');
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * ★ S9.42（2026-11-06）：csharp 的**可跑性**判据 —— 防"探测 ok / 白名单放行 / 一用就崩"的假阳性。
 *
 * 实测（2026-11-06 19:0x）：本机 `C:\Program Files\dotnet\dotnet.exe` **存在**，
 * `dotnet --list-runtimes` 也有 `Microsoft.NETCore.App 6.0.11/6.0.16`；
 * 但 `C:\Program Files\dotnet\sdk` **不存在**（`--list-sdks` 空），`dotnet-script` 也不在，
 * 于是 `buildCommand` 拼出的 `dotnet script <file>` 真跑时回 **exit 2147516561**：
 *   「The application 'script' does not exist."  "No .NET SDKs were found.」
 * 而 `ctx({op:"run",language:"csharp"})` 当时被白名单放行（`allowed` 里就写着 csharp）
 * —— **白名单广告了一个跑不动的语言**，与 R13 的 perl 假阳性同族（教训六十三）。
 *
 * 判据（两条都满足才算可用）：
 *   ① `dotnet` 安装根下有 `sdk`（能编译/能 `dotnet script`）；
 *   ② `dotnet-script` 在位（`~\.dotnet\tools\dotnet-script.exe` 或 PATH 上）。
 * 注意：**这判据只作用于 csharp**；判掉时 `buildCommand` 仍保留（用户哪天装了 SDK 就自动恢复）。
 */
function hasUsableDotnet(dotnetPath) {
    // ★ 第一版写错了（2026-11-06 19:5x 当场实测抓到）：把 dotnetPath 自己也当成"可用依据"，
    //   于是 dotnet.exe 一存在就 return true —— **等于没判**（本机实测 csharp 仍被判 ok）。
    //   判据的立足点是「能不能跑 .csx」，不是「dotnet.exe 在不在」——后者探测层已经知道了。
    const home = process.env.USERPROFILE || process.env.HOME;
    // ① `dotnet-script` 在位（`~\.dotnet\tools\dotnet-script.exe`）—— 最直接的一条：
    //   buildCommand 拼的就是 `dotnet script <file>`，宿主工具在，命令才能成。
    if (home) {
        const tool = path.join(home, '.dotnet', 'tools', isWin() ? 'dotnet-script.exe' : 'dotnet-script');
        try { if (statSync(tool, { throwIfNoEntry: false })?.isFile()) return true; }
        catch { /* 判不了 → 下一路 */ }
    }
    // ② 安装根下有非空的 `sdk` 目录（能编译，也就意味着 `dotnet <dll>` 那条正规链能拼）
    try {
        const sdkDir = path.join(path.dirname(String(dotnetPath)), 'sdk');
        if (statSync(sdkDir, { throwIfNoEntry: false })?.isDirectory()) {
            if (readdirSync(sdkDir).length > 0) return true;
        }
    }
    catch { /* 判不了 */ }
    return false;
}

/**
 * 探测全部 12 种语言。返回 `{ runtimes, languages, shellReason }`。
 * javascript 兜底顺序（2026-11-04 真机定）：PATH → 受管 node → execPath；
 * 每次兜底都显式标 source + warn，不静默。受管命中时顺带把 node 目录注入 PATH
 * （老引擎硬约束#3：摘同名再前置，防 pwsh 时代 PATH 里的重复 node 目录随机抢答——
 *   这里简化：PATH 里本就没有 node 才会走到兜底，直接前置受管目录即可）。
 */
export function detectRuntimes(env = process.env, log = () => {}) {
    const runtimes = {};
    const shellPath = resolveShellPath(env, log);

    for (const lang of EXEC_LANGUAGES) {
        if (lang === 'shell') {
            runtimes.shell = shellPath ? { path: shellPath, source: 'shell-resolution' } : null;
            continue;
        }
        const hit = findRuntime(lang, env);
        if (hit) {
            // ★ S9.42：csharp 的**可跑性**复核（文件在 ≠ 能用）。见 hasUsableDotnet 的注释。
            if (lang === 'csharp' && !hasUsableDotnet(hit.path)) {
                WARN(`csharp 的 dotnet.exe 在（${hit.path}）但没有 SDK 也没有 dotnet-script：`
                    + '真跑必崩（No .NET SDKs were found）→ 按假阳性判未安装（S9.42 / 教训六十三）');
                runtimes.csharp = null;
                continue;
            }
            runtimes[lang] = hit;
            continue;
        }
        // ★① javascript 兜底链：受管 node（DSH 安装树）优先于 execPath。
        if (lang === 'javascript') {
            const managed = findManagedNode();
            if (managed) {
                WARN(`javascript 运行时不在 PATH 上，使用 DSH 受管 node=${managed.exe}（source=dsh-managed）`);
                runtimes.javascript = { path: managed.exe, source: 'dsh-managed' };
                continue;
            }
            const execPath = process.execPath;
            const base = runtimeBasename(execPath ?? '').replace(/\.exe$/i, '');
            if (execPath && ['node', 'bun', 'deno'].includes(base)) {
                try {
                    if (statSync(execPath, { throwIfNoEntry: false })?.isFile()) {
                        WARN(`javascript 运行时不在 PATH 上，退回 process.execPath=${execPath}（source=execPath-fallback，非用户安装的 node）`);
                        runtimes.javascript = { path: execPath, source: 'execPath-fallback' };
                        continue;
                    }
                }
                catch { /* execPath 悬空 → 继续当未安装 */ }
            }
        }
        // ★ S9.42：python 兜底链（与 javascript 同等待遇）—— PATH 上是 Store 桩（exit 9009）时，
        //   退到 DSH 随包 python。**只此一种语言**，其余严格 PATH（没实测过就是不兜底）。
        if (lang === 'python') {
            const managedPy = findManagedPython();
            if (managedPy) {
                WARN(`python 运行时不在 PATH 上（PATH 里可能只有 WindowsApps 的 9009 桩），`
                    + `使用 DSH 随包 python=${managedPy.exe}（source=${managedPy.source}）`);
                runtimes.python = { path: managedPy.exe, source: managedPy.source };
                continue;
            }
        }
        runtimes[lang] = null;
    }

    const languages = EXEC_LANGUAGES.map((language) => {
        const hit = runtimes[language];
        return {
            language,
            ok: Boolean(hit?.path),
            path: hit?.path ?? null,
            source: hit?.source ?? null,
            version: hit?.path ? getVersion(hit.path, language === 'go' ? ['version'] : ['--version']) : 'unknown',
        };
    });
    return { runtimes, languages };
}

/** 1.2.2 `getAvailableLanguages()` 的同名面：只回「探测得到」的语言名。 */
export function getAvailableLanguages(env = process.env) {
    const { languages } = detectRuntimes(env);
    return languages.filter((l) => l.ok).map((l) => l.language);
}

/**
 * 把「脚本文件路径」拼成 argv（1.2.2 buildCommand 那条链）。
 * 全部 argv 直启、`shell:false`；rust 走编译特例，由 index.js 接住。
 */
export function buildCommand(runtimes, language, filePath) {
    const rt = runtimes?.[language];
    if (!rt?.path) {
        const e = new Error(`${language} 运行时不可用`);
        e.code = 'RUNTIME_MISSING';
        throw e;
    }
    const p = rt.path;
    switch (language) {
        case 'javascript':
            return isBun(p) ? [p, 'run', filePath] : [p, filePath];
        case 'typescript':
            if (isBun(p)) return [p, 'run', filePath];
            return runtimeBasename(p).toLowerCase().startsWith('tsx') ? [p, filePath] : [p, filePath];
        case 'python':
            return [p, filePath];
        case 'shell': {
            if (isWin()) {
                const name = String(p).toLowerCase();
                if (name.includes('powershell') || name.includes('pwsh')) {
                    // Windows PowerShell 默认 Restricted；进程级 Bypass 不改机器/用户策略。
                    return [p, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filePath];
                }
                // cmd.exe：/d 不读 AUTORUN，/s 强制引号规则，/c 执行完退出。
                return [p, '/d', '/s', '/c', filePath];
            }
            // POSIX sh/bash：`-c "source '<path>'"` —— 直接传文件参数会被 MSYS 改路径。
            const escaped = String(filePath).replace(/'/g, "'\\''");
            return [p, '-c', `source '${escaped}'`];
        }
        case 'ruby':
            return [p, filePath];
        case 'go':
            return [p, 'run', filePath];
        case 'rust':
            return ['__rust_compile_run__', filePath];
        case 'php':
            return [p, filePath];
        case 'perl':
            return [p, filePath];
        case 'r':
            return [p, filePath];
        case 'elixir':
            return [p, filePath];
        case 'csharp': {
            // ★ R12：.NET 宿主 `dotnet.exe` 不能直接吃 .csx 文件参数（实测报
            //   "The application 'script.csx' does not exist"）。csx 必须经 `dotnet script`。
            //   而 `dotnet script` 是后装的可选工具，不在 .NET SDK 里 —— 所以这里按
            //   `dotnet <dir>/script.dll` 那条正规链**拼不出来**时，退回 `dotnet script <file>`，
            //   由运行时自己给"没装 dotnet-script"的可读错误（比我们自己猜要诚实）。
            const isDotnet = /(^|[\\/])dotnet(\.exe)?$/i.test(p);
            return isDotnet ? [p, 'script', filePath] : [p, filePath];
        }
        default: {
            const e = new Error(`buildCommand: 不认识的语言 ${language}`);
            e.code = 'UNKNOWN_LANGUAGE';
            throw e;
        }
    }
}

/** 临时脚本文件名（1.2.2 buildScriptFilename）。 */
export function buildScriptFilename(language, platform = process.platform, shellPath = null) {
    if (platform === 'win32' && language === 'shell') {
        const shellName = String(shellPath ?? '').toLowerCase();
        if (shellName.includes('powershell') || shellName.includes('pwsh')) return 'script.ps1';
        const base = shellName.split(/[\\/]/).pop() ?? shellName;
        if (base === 'cmd' || base === 'cmd.exe') return 'script.cmd';
        return 'script';
    }
    return `script.${SCRIPT_EXT[language]}`;
}
