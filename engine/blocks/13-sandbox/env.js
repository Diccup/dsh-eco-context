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
 * 13-sandbox/env.js — 子进程环境：父 env 去掉「能注入代码/能改行为」的变量
 *
 * 干什么：把 `process.env` 拷一份给子进程，但先剥掉一整类危险变量，再叠调用方给的 overrides。
 * 为什么这样：移植自 `engine/ref/current-engine/executor.js` 的 `#buildSafeEnv`（只读基线）。
 *            1.2.2 的那张 DENIED 表每条都挂 CVE / MITRE / 实测依据，不是随手列的；
 *            2.0 的 `buildChildEnv` 只剥 `NODE_*_OPTIONS` 那一小撮，**太松**，我们按 1.2.2 的来。
 * 边界：纯函数，只产 env 对象，不读文件、不 spawn。
 */

import { existsSync } from 'node:fs';

const isWin = () => process.platform === 'win32';

/**
 * 拒绝表。每条都对应一条「不剥就会被利用」的事实：
 * 自动执行脚本 / 注入 CLI 选项 / 换编译器或库的加载路径 / 挂调试器或 profiler。
 * 完整依据见 ref/current-engine/executor.js L480-578 的行内注释。
 */
const DENIED = new Set([
    // ── Shell：非交互启动时自动 source、提示符前执行、开 xtrace 把命令打到 stdout ──
    'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PS4', 'SHELLOPTS', 'BASHOPTS',
    'CDPATH', 'INPUTRC', 'BASH_XTRACEFD',
    // ── Node：--require / --loader / --inspect 注入 ──
    'NODE_OPTIONS', 'NODE_PATH',
    // ── Python：交互模式自动执行、换 stdlib 位置、import 链触发 RCE ──
    'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONWARNINGS', 'PYTHONBREAKPOINT', 'PYTHONINSPECT',
    // ── Ruby / Perl：注入 CLI 选项（-r/-M 直接加载文件）与模块搜索路径 ──
    'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'PERL5DB',
    // ── Elixir / Erlang：erl flag 里 -eval 直接跑代码 ──
    'ERL_AFLAGS', 'ERL_FLAGS', 'ELIXIR_ERL_OPTIONS', 'ERL_LIBS',
    // ── Go / Rust：编译器与链接器 flag 注入、换编译器二进制 ──
    'GOFLAGS', 'CGO_CFLAGS', 'CGO_LDFLAGS',
    'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'RUSTFLAGS',
    // ── PHP / R：配置文件与启动脚本注入 ──
    'PHPRC', 'PHP_INI_SCAN_DIR', 'R_PROFILE', 'R_PROFILE_USER', 'R_HOME',
    // ── .NET / C#：启动钩子、额外依赖、共享 store 探测路径、运行时根替换 ──
    'DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS', 'DOTNET_SHARED_STORE',
    'DOTNET_ROOT', 'DOTNET_ROOT(x86)', 'DOTNET_HOST_PATH',
    // ── .NET profiler / 诊断端口：把任意 DLL 挂进 dotnet 宿主、peer attach ──
    'CORECLR_PROFILER', 'CORECLR_PROFILER_PATH', 'CORECLR_PROFILER_PATH_32',
    'CORECLR_PROFILER_PATH_64', 'CORECLR_PROFILER_PATH_ARM32', 'CORECLR_PROFILER_PATH_ARM64',
    'CORECLR_ENABLE_PROFILING', 'DOTNET_PROFILER_PATH', 'DOTNET_PROFILER_PATH_32',
    'DOTNET_PROFILER_PATH_64', 'DOTNET_PROFILER_PATH_ARM32', 'DOTNET_PROFILER_PATH_ARM64',
    'DOTNET_DiagnosticPorts', 'DOTNET_BUNDLE_EXTRACT_BASE_DIR',
    // ── 动态链接：加载任意 .so / .dylib ──
    'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    // ── OpenSSL：加载引擎模块 → .so 执行 ──
    'OPENSSL_CONF', 'OPENSSL_ENGINES',
    // ── 编译器替换 ──
    'CC', 'CXX', 'AR',
    // ── Git：hook / config / 子命令 / ssh 注入 ──
    'GIT_TEMPLATE_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
    'GIT_EXEC_PATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
]);

/**
 * 构造子进程 env。
 * @param {NodeJS.ProcessEnv} [parent] 默认 `process.env`
 * @param {Record<string,string>} [overrides] 调用方强制值，最后叠上去（覆盖父值）
 * @param {string} [tmpDir] 沙箱临时目录，写进 `TMPDIR`
 */
export function buildChildEnv(parent = process.env, overrides = {}, tmpDir = '') {
    const env = {};
    for (const [key, val] of Object.entries(parent ?? {})) {
        if (val === undefined) continue;
        if (DENIED.has(key)) continue;
        // bash 导出的函数是 `BASH_FUNC_xxx%%`，塞进子进程 env 会让某些 shell 直接报错
        if (key.startsWith('BASH_FUNC_')) continue;
        // COMPlus_* 是 .NET 的 DOTNET_* 别名（大小写不敏感），逐个列会漏，按前缀扫
        if (/^COMPlus_/i.test(key)) continue;
        env[key] = val;
    }

    // 沙箱强制值
    if (tmpDir) env.TMPDIR = tmpDir;
    env.HOME = parent?.HOME ?? parent?.USERPROFILE ?? tmpDir;
    env.LANG = 'en_US.UTF-8';
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONUTF8 = '1';
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0'; // 父进程开了 FORCE_COLOR 时子进程仍要朴素输出（GP4）

    // Windows 用 "Path"，统一成 "PATH"
    if (isWin() && !env.PATH && env.Path) {
        env.PATH = env.Path;
        delete env.Path;
    }
    if (!env.PATH) env.PATH = isWin() ? '' : '/usr/local/bin:/usr/bin:/bin';

    if (isWin()) {
        // MSYS 的路径转换开关会挡住原生 git 的参数转换，不带进沙箱（#791）
        for (const key of Object.keys(env)) {
            const upper = key.toUpperCase();
            if (upper === 'MSYS_NO_PATHCONV' || upper === 'MSYS2_ARG_CONV_EXCL') delete env[key];
        }
    }

    // SSL 证书：Python/Ruby 的 HTTPS 要靠它
    if (!env.SSL_CERT_FILE && !isWin()) {
        for (const p of [
            '/etc/ssl/cert.pem',
            '/etc/ssl/certs/ca-certificates.crt',
            '/etc/pki/tls/certs/ca-bundle.crt',
            '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
        ]) {
            if (existsSync(p)) { env.SSL_CERT_FILE = p; break; }
        }
    }

    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) env[k] = String(v);
    }
    return env;
}
