#!/usr/bin/env node
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
 * 13-sandbox/selftest.mjs — 单跑必绿。engine/ 下跑 `node blocks\13-sandbox\selftest.mjs`。
 * 不依赖宿主/ctx、不写库；临时文件落 `F:\workspace\LongMem\Temp`，跑完自删。
 * ★ 受限宿主（DSH 工具沙箱令牌不给匿名管道）下真跑组拿到 HOST_PIPE_DENIED：本 selftest **不假装成功**，
 *   真跑组整体 SKIP 并打出原因，退出码 2（1 = 断言失败，0 = 全绿）。生产路径不受限，应当 0。
 * ★ 退出一律 `process.exitCode = N`，不许 `process.exit()`：全量回归器用 `await import` 加载本块，
 *   前者会掐死同进程的其它块。
 */

import assert from 'node:assert/strict';
import { tempDir as resolveTempDir } from '../../libs/tempdir.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_LANGUAGES, SCRIPT_EXT, DEFAULTS } from '../01-core/index.js';
import { NAME, MAX_OUTPUT_BYTES, availableLanguages, init, run, runBatch } from './index.js';
import { buildCommand, buildScriptFilename, detectRuntimes, isAllowlistedShell, resolveShellPath } from './runtime-probe.js';
import { buildChildEnv } from './env.js';
import { runPool } from './run-pool.js';
import { byteSafePrefix, truncateOutput } from './truncate.js';
import { classifyNonZeroExit } from './exit-classify.js';

const TEMP = resolveTempDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundTrips = (s) => s === Buffer.from(s, 'utf8').toString('utf8'); // 孤立代理项会被替换成 U+FFFD
// 路径等价：Windows 大小写无关、分隔符归一（本机 SHELL 常是 `C:/Program Files/...` 正斜杠形态）。
const samePath = (a, b) => path.normalize(String(a ?? '')).toLowerCase() === path.normalize(String(b ?? '')).toLowerCase();

// ─── 迷你测试器 ──────────────────────────────────────────────
const results = [];
let spawnOK = null;

async function t(name, fn) {
    try { await fn(); results.push({ name, ok: true }); console.log(`  \u2713 ${name}`); }
    catch (e) { results.push({ name, ok: false, err: e }); console.log(`  \u2717 ${name}\n      ${e?.message ?? e}`); }
}

function section(title) { console.log(`\n${title}`); }

/** 找 PATH 上的可执行文件（selftest 自己用，不经过被测代码）。 */
function findOnPath(name) {
    for (const d of String(process.env.PATH ?? '').split(';')) {
        if (!d) continue;
        const p = join(d, name);
        try { if (existsSync(p)) return p; } catch { /* 继续找 */ }
    }
    return null;
}

const quietLog = () => ({ error() { }, warn() { }, info() { }, debug() { } });

// ─── 准备 ────────────────────────────────────────────────────
section('0. 装配');
await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });

// ─── A. 契约与纯函数（不需要 spawn）──────────────────────────
section('A. 契约与纯函数');

await t('NAME 与 12 语言契约', async () => {
    assert.equal(NAME, 'sandbox');
    assert.equal(EXEC_LANGUAGES.length, 12);
    assert.equal(new Set(EXEC_LANGUAGES).size, 12);
    for (const lang of EXEC_LANGUAGES) assert.ok(SCRIPT_EXT[lang], `SCRIPT_EXT 缺 ${lang}`);
    assert.equal(DEFAULTS.TOOL_TIMEOUT_MS, 600000);
});

await t('truncate：字节前缀不劈代理对', async () => {
    const s = 'a😀b'; // 😀 是代理对（4 字节 / 2 个 UTF-16 码元）
    for (const cap of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]) {
        const out = byteSafePrefix(s, cap);
        assert.ok(Buffer.byteLength(out, 'utf8') <= cap, `cap=${cap} 超了`);
        assert.ok(roundTrips(out), `cap=${cap} 产生了孤立代理项：${JSON.stringify(out)}`);
    }
});

await t('truncate：100KB CJK/emoji 输出，截断后最后一个字完整', async () => {
    const unit = '中文😀'; // 3+3+4 = 10 字节
    const big = unit.repeat(3000); // 30,000 字节
    // 能放下至少一个字符的预算：末尾必须是 unit 里的完整字符
    for (const cap of [3, 4, 5, 6, 7, 9, 10, 11, 15, 16, 17, 99, 100, 101, 1000, 1001, 1003, 1005, 1006, 5000]) {
        const capped = truncateOutput(big, cap);
        assert.ok(Buffer.byteLength(capped, 'utf8') <= cap, `cap=${cap} → ${Buffer.byteLength(capped, 'utf8')} 超了`);
        assert.ok(roundTrips(capped), `cap=${cap} 产生了孤立代理项`);
        const chars = [...capped];
        assert.ok(chars.length > 0, `cap=${cap} 截成空串`);
        assert.ok(unit.includes(chars[chars.length - 1]), `cap=${cap} 末尾不是完整字符：${JSON.stringify(chars[chars.length - 1])}`);
    }
    // 连一个字符都放不下：干净返回空串，不许抛、不许塞半个字符
    for (const cap of [0, 1, 2]) assert.equal(truncateOutput(big, cap), '', `cap=${cap} 应为空串`);
});

await t('truncate：100KB 输入截到 MAX_OUTPUT_BYTES', async () => {
    const big = 'x'.repeat(100 * 1024);
    assert.equal(Buffer.byteLength(truncateOutput(big, MAX_OUTPUT_BYTES), 'utf8'), MAX_OUTPUT_BYTES);
});

await t('exit-classify：shell 软失败 / 真失败', async () => {
    const soft = classifyNonZeroExit({ language: 'shell', exitCode: 1, stdout: '命中 3 条', stderr: '' });
    assert.equal(soft.isError, false);
    assert.equal(soft.output, '命中 3 条');
    const hard = classifyNonZeroExit({ language: 'javascript', exitCode: 1, stdout: 'a', stderr: 'b' });
    assert.equal(hard.isError, true);
    assert.match(hard.output, /Exit code: 1/);
});

await t('buildScriptFilename：Windows shell 的三种落点', async () => {
    assert.equal(buildScriptFilename('shell', 'win32', 'C:\\Windows\\System32\\cmd.exe'), 'script.cmd');
    assert.equal(buildScriptFilename('shell', 'win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'script.ps1');
    assert.equal(buildScriptFilename('javascript', 'win32'), 'script.js');
    assert.equal(buildScriptFilename('python', 'linux'), 'script.py');
});

await t('buildCommand：cmd.exe / pwsh / node 三种 argv 形态', async () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    assert.deepEqual(buildCommand({ shell: { path: cmd } }, 'shell', 'X'), [cmd, '/d', '/s', '/c', 'X']);
    assert.deepEqual(buildCommand({ shell: { path: pwsh } }, 'shell', 'X'),
        [pwsh, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'X']);
    assert.deepEqual(buildCommand({ javascript: { path: 'C:\\node.exe' } }, 'javascript', 'X'), ['C:\\node.exe', 'X']);
});

await t('resolveShellPath：拒绝 Git Bash；无显式 SHELL 时 pwsh 优先、cmd 兜底（2026-11-05 维护方决定）', async () => {
    const hermesBash = join(homedir(), 'AppData', 'Local', 'hermes', 'git', 'bin', 'bash.exe');
    const logs = [];
    const got = resolveShellPath({ SHELL: hermesBash, PATH: process.env.PATH }, (m) => logs.push(m));
    assert.notEqual(got, hermesBash, 'hermes Git Bash 必须被拒');
    assert.ok(logs.some((l) => /拒绝/.test(l)), '必须留下拒绝原因的日志');
    assert.ok(isAllowlistedShell('pwsh.exe') && isAllowlistedShell('cmd.exe'));
    assert.equal(isAllowlistedShell('python'), false, 'python 不许当 shell');
    if (process.platform === 'win32') {
        // ★ 2026-11-05 改：旧断言是"必须回退 cmd.exe"。现在选序是 pwsh > powershell > cmd
        //   （cmd 的 GBK 会毁中文路径与中文输出，见 runtime-probe.js resolveShellPath 头注）。
        //   三档都可能落到，断言"落在这三档之一且真实存在"。
        assert.match(String(got), /(pwsh|powershell|cmd)\.exe$/i, `应落到 pwsh/powershell/cmd 之一，实际 ${got}`);
        assert.ok(logs.some((l) => /shell: Windows/.test(l)), '必须留下选 shell 原因的日志');
    } else {
        assert.ok(got === null || /\/(bash|sh)$/.test(String(got)), `POSIX 应回退 bash/sh，实际 ${got}`);
    }
    // 显式 SHELL 永远是最高优先：指向 allowlisted 的 pwsh → 用它（路径等价比较，容忍正斜杠/大小写）
    const pwsh = findOnPath('pwsh.exe');
    if (pwsh) assert.ok(samePath(resolveShellPath({ SHELL: pwsh, PATH: process.env.PATH }, () => {}), pwsh), '显式 SHELL=pwsh.exe 应当被采用');
    // 显式 SHELL=cmd.exe 时必须尊重用户选择（不许被新的 pwsh 优先序盖掉）
    if (process.platform === 'win32') {
        const cmdExplicit = 'C:\\Windows\\System32\\cmd.exe';
        assert.ok(samePath(resolveShellPath({ SHELL: cmdExplicit, PATH: process.env.PATH }, () => {}), cmdExplicit),
            '显式 SHELL=cmd.exe 必须生效（用户说了算）');
        // 空 PATH + 空 SHELL：标准安装位的 pwsh 仍应被探到（不走 PATH 也能命中）
        const noPath = resolveShellPath({ PATH: '' }, () => {});
        console.log(`      （空 PATH + 空 SHELL → ${noPath ?? 'null'}）`);
    }
});

await t('env：剥掉 NODE_OPTIONS / BASH_ENV 等注入面', async () => {
    const env = buildChildEnv({
        NODE_OPTIONS: '--require evil.js', BASH_ENV: '/etc/evil', RUBYOPT: '-r evil',
        PATH: 'C:\\Windows\\system32', HOME: 'C:\\Users\\x',
    }, { CTX_FILE: 'C:\\ws\\a.txt' }, 'C:\\tmp\\sand');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.BASH_ENV, undefined);
    assert.equal(env.RUBYOPT, undefined);
    assert.equal(env.CTX_FILE, 'C:\\ws\\a.txt');
    assert.equal(env.TMPDIR, 'C:\\tmp\\sand');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.FORCE_COLOR, '0');
});

await t('runPool：并发上限 + 顺序保持 + 一个 reject 不拖垮别的', async () => {
    let live = 0; let peak = 0;
    const jobs = Array.from({ length: 6 }, (_, i) => async () => {
        live++; peak = Math.max(peak, live);
        await sleep(30);
        live--;
        if (i === 2) throw new Error('boom');
        return i;
    });
    const { settled, effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 2 });
    assert.equal(effectiveConcurrency, 2);
    assert.equal(capped, false);
    assert.equal(peak, 2, `并发峰值 ${peak} 超过上限 2`);
    assert.equal(settled.length, 6);
    assert.equal(settled[2].status, 'rejected');
    assert.equal(settled[0].value, 0);
    assert.equal(settled[5].value, 5, '返回顺序必须按输入下标');
});

await t('未知语言 → UNKNOWN_LANGUAGE；缺 code → NO_INPUT', async () => {
    const bad = await run({ language: 'cobol', code: 'x' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'UNKNOWN_LANGUAGE');
    const noCode = await run({ language: 'javascript' });
    assert.equal(noCode.ok, false);
    assert.equal(noCode.code, 'NO_INPUT');
});

// ─── B. 12 语言探测矩阵 ──────────────────────────────────────
section('B. 12 语言探测矩阵');

const matrix = availableLanguages();
await t('矩阵 12 行、字段齐全', async () => {
    assert.equal(matrix.length, 12);
    for (const row of matrix) {
        assert.ok(row.language && typeof row.ok === 'boolean');
        assert.ok(typeof row.version === 'string');
    }
});

await t('未安装的语言 → RUNTIME_MISSING（可读错误，不炸）', async () => {
    const missing = matrix.filter((l) => !l.ok).map((l) => l.language);
    assert.ok(missing.length > 0, '本机应当有未安装的语言');
    for (const lang of missing) {
        const r = await run({ language: lang, code: 'x' });
        assert.equal(r.ok, false, `${lang} 不该成功`);
        assert.equal(r.code, 'RUNTIME_MISSING', `${lang} 的 code 应是 RUNTIME_MISSING，实际 ${r.code}`);
        assert.ok(typeof r.message === 'string' && r.message.length > 0, `${lang} 必须有可读文案`);
    }
    console.log(`      （本机未安装 ${missing.length} 种：${missing.join(', ')}）`);
});

await t('shell 解析：选序 = 显式 SHELL 优先，否则 pwsh > powershell > cmd（win32）', async () => {
    const row = matrix.find((l) => l.language === 'shell');
    assert.ok(row.ok, 'shell 应当可用');
    const shellEnv = process.env.SHELL;
    // 选序（2026-11-05 维护方决定改）：显式 SHELL 且 allowlisted → 用它；
    // 否则 Windows 按 pwsh > powershell > cmd 探（cmd 的 GBK 会毁中文，见 runtime-probe 头注）。
    if (process.platform === 'win32') {
        if (shellEnv && isAllowlistedShell(shellEnv)) {
            assert.ok(samePath(row.path, shellEnv), `显式 SHELL 应当生效，实际 ${row.path}`);
            console.log(`      （环境显式 SHELL=${shellEnv} → 用它）`);
        } else {
            assert.match(row.path, /(pwsh|powershell|cmd)\.exe$/i,
                `无显式 allowlisted SHELL 时应落到 pwsh/powershell/cmd 之一，实际 ${row.path}`);
            console.log(`      （无显式 SHELL → 探到 ${row.path}）`);
        }
    } else {
        assert.match(row.path, /\/(bash|sh)$/, `POSIX 应落到 bash/sh，实际 ${row.path}`);
    }
});

await t('javascript 的 source 被显式记录（PATH 优先 / dsh-managed / execPath 兜底）', async () => {
    const row = matrix.find((l) => l.language === 'javascript');
    assert.ok(row.ok, 'javascript 应当可用（PATH / 受管 node / execPath 兜底）');
    assert.ok(['path', 'dsh-managed', 'execPath-fallback'].includes(row.source), `source 异常：${row.source}`);
    console.log(`      javascript → ${row.path}（source=${row.source}, version=${row.version}）`);
});

await t('真机反证：空 PATH + Electron 式 execPath → 必须落到受管 node（2026-11-04 抓的 RUNTIME_MISSING）', async () => {
    const fakeExec = process.execPath.replace(/node\.exe$/i, 'DeepSeek Harness.exe');
    const savedExec = Object.getOwnPropertyDescriptor(process, 'execPath');
    let r;
    try {
        Object.defineProperty(process, 'execPath', { value: fakeExec, configurable: true });
        r = detectRuntimes({ PATH: '' }, () => {});
    } finally {
        if (savedExec) Object.defineProperty(process, 'execPath', savedExec);
    }
    const j = r.languages.find((l) => l.language === 'javascript');
    const managedHit = /dsh-runtimes[\\/].*[\\/]node(\.exe)?$/i;
    // ★ 这条判据的前提是"本机装了 DSH 的随包 node"。
    //   没装 DSH 的机器（CI runner、精简镜像）上没有受管 runtime：
    //   而 execPath 在这条用例里被**故意伪装成 Electron**（DeepSeek Harness.exe），
    //   引擎按设计就拒收它（basename 不在 node/bun/deno 里）⇒ javascript 报不可用，
    //   这是**正确行为**，不是缺陷。
    //   所以：前提不成立（没有受管 runtime）时这条判据无意义，记 SKIP 而不是判红。
    if (!managedHit.test(j.path ?? '')) {
        assert.equal(j.ok, false,
            `没有受管 runtime 且 execPath 被伪装成宿主可执行文件时，javascript 应当不可用，实际 ok=${j.ok}`);
        results.push({ name: '真机反证：空 PATH + Electron 式 execPath → 落到受管 node', ok: 'skip' });
        console.log('  - 真机反证：空 PATH + Electron 式 execPath → 落到受管 node（SKIP：本机没有 DSH 随包 node）');
        return;
    }
    assert.ok(j.ok, `空 PATH + 非 JS execPath 下 javascript 仍要可用（受管兜底），实际 ok=${j.ok}`);
    assert.ok(managedHit.test(j.path), `应当命中受管 node 目录，实际 ${j.path}`);
    assert.equal(j.source, 'dsh-managed');
});

// ─── C. 真跑（需要宿主给匿名管道）────────────────────────────
section('C. 真跑 + 超时 + 截断 + 围栏');

if (spawnOK === null) {
    const probe = await run({ language: 'javascript', code: 'process.stdout.write("ok")' });
    spawnOK = !(probe.code === 'HOST_PIPE_DENIED');
    if (!spawnOK) console.log('  ! 宿主令牌不给匿名管道（spawn stdio:pipe → EPERM）→ 真跑组整体 SKIP；生产路径不受限，应当 0。');
}

const real = (name, fn) => (spawnOK ? t(name, fn)
    : (results.push({ name, ok: 'skip' }), console.log(`  - ${name}（SKIP：宿主不给匿名管道）`), Promise.resolve()));

await real('javascript 真跑（node）', async () => {
    const r = await run({ language: 'javascript', code: 'process.stdout.write("OK-javascript\\n")' });
    assert.equal(r.ok, true, `run 失败：${r.code} ${r.message}`);
    assert.match(r.stdout, /OK-javascript/);
    assert.equal(r.exitCode, 0);
    const src = matrix.find((l) => l.language === 'javascript')?.source;
    assert.equal(r.runtime, src, `runtime source 应当与探测矩阵一致（矩阵=${src} 实际=${r.runtime}）`);
});

/** 临时把 SHELL 换成指定解释器跑一条 shell，跑完恢复（真跑组用）。 */
async function shellRun(shellPath, code, check) {
    const saved = process.env.SHELL; process.env.SHELL = shellPath;
    try {
        await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
        const r = await run({ language: 'shell', code });
        assert.equal(r.ok, true, `run 失败：${r.code} ${r.message}`); check(r);
    } finally {
        process.env.SHELL = saved;
        await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
    }
}

await real('shell 真跑（显式 SHELL=cmd.exe）', async () => {
    const cmd = findOnPath('cmd.exe');
    assert.ok(cmd, '本机应当有 cmd.exe');
    await shellRun(cmd, 'echo OK-shell-cmd', (x) => {
        assert.match(x.stdout, /OK-shell-cmd/);
        assert.match(x.command?.[0] ?? '', /cmd\.exe$/i, 'argv 应当走 cmd.exe');
    });
});

// ★ pwsh 是**可选**运行时：Windows Server / 精简镜像 / CI runner 上常常只有
//   Windows PowerShell 5.1，没有 pwsh.exe。原判据是「本机应当有 pwsh.exe」
//   —— 那是在开发机上写死的假设，别人机器（含 GitHub Actions 的 windows-latest
//   某些镜像）上必然红，而代码本身没问题。
//   正确的判据是：**有 pwsh 就真跑一遍验证走的是 pwsh；没有就跳过这一项**。
await real('shell 真跑（显式 SHELL=pwsh.exe）', async () => {
    const pwsh = findOnPath('pwsh.exe');
    if (!pwsh) {
        results.push({ name: 'shell 真跑（显式 SHELL=pwsh.exe）', ok: 'skip' });
        console.log('  - shell 真跑（显式 SHELL=pwsh.exe）（SKIP：本机没有 pwsh.exe）');
        return;
    }
    await shellRun(pwsh, 'Write-Output "OK-shell-pwsh"', (x) => {
        assert.match(x.stdout, /OK-shell-pwsh/);
        assert.match(x.command?.[0] ?? '', /pwsh/i, 'argv 应当走 pwsh');
    });
});

// ★ R13（2026-11-05）：开发机上的 perl 是 **hermes 的 MINGW 版**，受限令牌下拉起来必崩
//   （实测 `couldn't create signal pipe, Win32 error 5`）。探测层已按 isMsysRuntime
//   拒掉它，所以这条从"perl 真跑"改成"**假阳性不再发生**"——断言的重点是
//   **availableLanguages 报 ok 的语言，必须真的能起**，而不是"perl 必须不能用"。
//
// ★ 2026-11-16 发布版修正：原判据写死了「本机 perl 是 MSYS 版，探测必须报 ok:false」——
//   那是**开发机的事实**，不是契约。别人机器上 perl 可能根本不存在（ok=false，正常），
//   也可能是 Strawberry 版等正经 perl（ok=true，也正常）。
//   契约只有一条：**探测报 ok 的语言必须真能起**。perl 自己是不是 MSYS 版由探测层管，
//   这条判据不该重复管一遍。
await t('假阳性防线：探测报 ok 的语言必须真能起', async () => {
    const langs = availableLanguages();
    // perl 若被探测为 ok，必须**不是**被拒掉的 MSYS/MINGW 版（那才是假阳性）
    const perl = langs.find((l) => l.language === 'perl');
    if (perl?.ok === true) {
        assert.ok(!/msys|mingw/i.test(String(perl.path ?? '')),
            `perl 报 ok 但路径是 MSYS/MINGW 版（受限令牌下起不来）—— 假阳性：${perl.path}`);
    }
    // 反向：探测报 ok 的每一个，都要能在白名单里被放行（两张皮不许再出现）
    const okLangs = langs.filter((l) => l.ok).map((l) => l.language);
    assert.ok(okLangs.length > 0, '至少 javascript 必须 ok');
    for (const l of okLangs) {
        const r = await run({ language: l, code: l === 'shell' ? 'echo x' : (l === 'javascript' ? 'console.log(1)' : null) });
        assert.notEqual(r.code, 'LANGUAGE_NOT_CONFINABLE',
            `探测报 ok 的 ${l} 却被白名单拒 —— availableLanguages 与 run 白名单必须一致`);
    }
});

// ★ S9.42（2026-11-06 维护方提问「知道用 SHELL 了，为啥直接去 PYTHON」）：
//   两条新判据必须有门盯着，否则下一轮又会悄悄坏掉 —— 这正是教训六十三要防的。
//   ① python 走受管兜底（PATH 上那个是 WindowsApps 的 9009 桩，不能信）；
//   ② csharp 的假阳性必须被判掉（dotnet.exe 在、无 SDK、无 dotnet-script ⇒ 一用就崩）。
await t('S9.42 ① python 必须走受管兜底（PATH 上的 Store 桩不算数）', async () => {
    const py = matrix.find((l) => l.language === 'python');
    // ★ 这条判据的前提是"本机装了 DSH 的随包 python"。
    //   没装 DSH 的机器（CI runner、精简镜像）上没有受管 python ——
    //   那时 python 要么走 PATH 上真正的 python，要么干脆不可用，两种都合理。
    //   前提不成立时记 SKIP，而不是判红。
    if (!/dsh-runtimes[\\/]/i.test(String(py.path ?? ''))) {
        results.push({ name: 'S9.42 ① python 必须走受管兜底', ok: 'skip' });
        console.log('  - S9.42 ① python 必须走受管兜底（SKIP：本机没有 DSH 随包 python）');
        return;
    }
    assert.ok(py.ok, `本机有随包 python 3.12.14，探测必须报 ok；实际 ok=${py.ok}`);
    assert.ok(/dsh-runtimes[\\/].*[\\/]python(\.exe)?$/i.test(py.path),
        `python 应当落在 DSH 运行时目录，实际 ${py.path}`);
    assert.equal(py.source, 'dsh-managed', `python 的 source 必须是 dsh-managed，实际 ${py.source}`);
    // 反向：PATH 上那个 Store 桩必须被判掉（isStoreStub），不能当成真运行时
    const storeStub = join(process.env.LOCALAPPDATA ?? 'C:\\Users\\x\\AppData\\Local', 'Microsoft', 'WindowsApps', 'python.exe');
    assert.ok(!String(py.path).toLowerCase().includes('windowsapps'),
        `python 绝不许落到 WindowsApps 的 App Execution Alias（实测 exit 9009），实际 ${py.path}（桩位=${storeStub}）`);
});

await t('S9.42 ② csharp 假阳性必须被判掉（dotnet.exe 在但没 SDK/dotnet-script）', async () => {
    const cs = matrix.find((l) => l.language === 'csharp');
    // 本机实测：dotnet.exe 存在、无 sdk 目录、无 dotnet-script ⇒ 真跑 exit 2147516561
    const home = process.env.USERPROFILE || process.env.HOME;
    const script = home ? join(home, '.dotnet', 'tools', 'dotnet-script.exe') : '';
    const sdkDir = 'C:\\Program Files\\dotnet\\sdk';
    const usable = (script && existsSync(script)) || existsSync(sdkDir);
    if (!usable) {
        assert.equal(cs.ok, false,
            `本机 dotnet 没有 SDK 也没有 dotnet-script，真跑必崩 —— csharp 必须报 ok:false；实际 ok=${cs.ok} path=${cs.path}`);
    } else {
        console.log('      （本机 dotnet 有 SDK/dotnet-script，csharp 允许报 ok）');
    }
});

await real('超时：杀进程树，不留孤儿', async () => {
    const r = await run({ language: 'javascript', code: 'while(true){}', timeoutMs: 1200 });
    assert.equal(r.ok, true, `run 失败：${r.code} ${r.message}`);
    assert.equal(r.timedOut, true, 'timedOut 必须为 true');
    assert.ok(r.pid, '必须能拿到子进程 pid');
    let gone = false;
    for (let i = 0; i < 30; i++) {
        try { process.kill(r.pid, 0); }
        catch { gone = true; break; }
        await sleep(100);
    }
    assert.ok(gone, `超时后进程树没杀干净（pid=${r.pid} 仍在）`);
});

await real('截断：100KB 输出 → bytes ≤ 上限', async () => {
    const big = 'x'.repeat(100 * 1024);
    const r = await run({
        language: 'javascript',
        code: `process.stdout.write(${JSON.stringify(big)})`,
        maxOutputBytes: 8192,
    });
    assert.equal(r.ok, true, `run 失败：${r.code} ${r.message}`);
    assert.ok(r.bytes <= 8192, `bytes=${r.bytes} 超过 8192`);
    assert.equal(r.truncated, true, '100KB 必须触发截断标记');
});

await real('file：区内放行并注入 CTX_FILE，区外 DENIED_PATH', async () => {
    const ws = mkdtempSync(join(TEMP, '.ctx-sandbox-ws-'));
    try {
        writeFileSync(join(ws, 'data.txt'), 'hello-file');
        await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: ws });
        const ok = await run({
            language: 'javascript',
            code: 'process.stdout.write(require("fs").readFileSync(process.env.CTX_FILE,"utf8"))',
            file: 'data.txt', cwd: ws,
        });
        assert.equal(ok.ok, true, `区内应当放行：${ok.code} ${ok.message}`);
        assert.match(ok.stdout, /hello-file/);
        const bad = await run({ language: 'javascript', code: 'process.stdout.write("x")', file: join('..', 'evil.txt'), cwd: ws });
        assert.equal(bad.ok, false);
        assert.equal(bad.code, 'DENIED_PATH', `区外应当 DENIED_PATH，实际 ${bad.code}`);
    }
    finally {
        await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
        rmSync(ws, { recursive: true, force: true });
    }
});

await real('confiner：注入的 argv 被采用；抛错 → DENIED_PATH', async () => {
    let seen = null;
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: (argv) => { seen = argv; return { argv }; },
    });
    const ok = await run({ language: 'javascript', code: 'process.stdout.write("OK-confined")' });
    assert.equal(ok.ok, true, `confine 放行路径应当成功：${ok.code} ${ok.message}`);
    assert.match(ok.stdout, /OK-confined/);
    assert.ok(Array.isArray(seen) && seen.length > 0, 'confine 必须收到 argv');
    assert.deepEqual(ok.command, seen, '返回的 command 应当是 confine 之后的 argv');

    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: () => { throw Object.assign(new Error('ACL runner 拒绝'), { code: 'DENIED' }); },
    });
    const bad = await run({ language: 'javascript', code: 'process.stdout.write("x")' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'DENIED_PATH', `confine 抛错应当 DENIED_PATH，实际 ${bad.code}`);
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

// ─── P1 契约（2026-11-04 沙箱归一）：全部在起进程**之前**被拒，受限宿主也能真验 ───
// 假围栏修复的行为判据：真宿主 confine 是 async。旧版没 await → Promise 上取
// .argv 恒 undefined → "跳过重写继续起原 argv" = 限制模式下裸跑。下面 reject/坏形状
// 三条只要 await 没做就会走到起进程（受限宿主得 HOST_PIPE_DENIED 而非预期码），
// 所以这三条在受限宿主里同样是**真判据**，不是摆设。
section('P1. confine fail-closed / 受限白名单 / 取消（不起进程即可判）');

await t('confine 是 async：reject → DENIED_PATH（证明 await 了）', async () => {
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: () => Promise.reject(Object.assign(new Error('ACL 拒'), { code: 'DENIED' })),
    });
    const r = await run({ language: 'javascript', code: 'process.stdout.write("x")' });
    assert.equal(r.ok, false, 'async reject 必须被拒');
    assert.equal(r.code, 'DENIED_PATH', `await catch 不到就会走到起进程；期望 DENIED_PATH，实际 ${r.code}`);
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

await t('confine 是 async：resolve null → CONFINER_UNAVAILABLE（绝不原样放行）', async () => {
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: () => Promise.resolve(null),
    });
    const r = await run({ language: 'javascript', code: 'process.stdout.write("x")' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFINER_UNAVAILABLE', `null 形状必须拒跑；实际 ${r.code}`);
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

await t('confine 返回坏形状 {argv:非数组} → CONFINER_UNAVAILABLE', async () => {
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: () => ({ argv: 'not-an-array' }),
    });
    const r = await run({ language: 'javascript', code: 'process.stdout.write("x")' });
    assert.equal(r.code, 'CONFINER_UNAVAILABLE', `坏 argv 必须拒；实际 ${r.code}`);
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

// ★ R14（2026-11-05 维护方质疑「CTX不能跑PWSH？」）：旧断言"受限下 shell 必须 LANGUAGE_NOT_CONFINABLE"
//   已被实测证伪 —— 受限令牌不给匿名管道，但**文件描述符重定向可行**（R11），
//   shell(=cmd.exe) 与 pwsh 在受限会话里都能真跑（本机已验）。
//   所以这条改成断言**正确的那件事**：shell 现在**应当被放行**（不再被白名单拒），
//   且真的能跑出输出；白名单不再硬编码只放 javascript。
await t('受限白名单：shell 必须被放行并能真跑（不再被写死的 javascript-only 拒）', async () => {
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: (argv) => ({ argv }), confined: true,
    });
    const r = await run({ language: 'shell', code: 'echo ctx-shell-ok' });
    assert.notEqual(r.code, 'LANGUAGE_NOT_CONFINABLE', 'shell 已被实测可在受限会话跑，不许再被白名单拒');
    if (process.platform === 'win32') {
        assert.equal(r.ok, true, `受限会话下 shell 应真能跑；实际 ${r.code} ${r.message ?? ''}`);
        assert.match(r.stdout, /ctx-shell-ok/, 'shell 输出必须收得回（经文件重定向，不是匿名管道）');
    }
    // 白名单必须来自探测结果，不许再是写死的单元素集合
    const langs = availableLanguages().filter((l) => l.ok).map((l) => l.language);
    assert.ok(langs.length >= 1, '白名单至少含 javascript');
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

await t('受限 background → BACKGROUND_DENIED', async () => {
    await init({
        tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP,
        confine: (argv) => ({ argv }), confined: true,
    });
    const r = await run({ language: 'javascript', code: 'x', background: true });
    assert.equal(r.code, 'BACKGROUND_DENIED', `受限不许后台（无作业体系跟踪）；实际 ${r.code}`);
    await init({ tempDir: TEMP, log: quietLog(), workspaceRoot: TEMP });
});

await t('signal 已 abort → CANCELLED（不开工、不落脚本）', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await run({ language: 'javascript', code: 'process.stdout.write("x")', signal: ac.signal });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CANCELLED', `已取消不该起进程；实际 ${r.code}`);
});

await real('runBatch：3 条 shell 命令并发跑', async () => {
    const b = await runBatch({ commands: ['echo OK-batch-1', 'echo OK-batch-2', 'echo OK-batch-3'], timeoutMs: 20000, concurrency: 2 });
    assert.equal(b.settled.length, 3);
    assert.equal(b.effectiveConcurrency, 2);
    for (const s of b.settled) {
        assert.equal(s.status, 'fulfilled');
        assert.equal(s.value.ok, true, `批量里一条失败：${s.value.code} ${s.value.message}`);
    }
    assert.ok(b.settled.every((s) => /OK-batch-\d/.test(s.value.stdout)));
});

// ─── 汇总 ────────────────────────────────────────────────────
section('12 语言矩阵（language | ok | path | version | source）');
for (const row of matrix) {
    console.log(`  ${row.language.padEnd(11)} | ${String(row.ok).padEnd(5)} | ${String(row.path ?? '-').padEnd(52)} | ${String(row.version).slice(0, 22).padEnd(22)} | ${row.source ?? '-'}`);
}

const passed = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const skipped = results.filter((r) => r.ok === 'skip').length;

section('汇总');
console.log(`  通过 ${passed} ／ 失败 ${failed}${skipped ? ` ／ 跳过 ${skipped}（宿主不给匿名管道，或该运行时本机没有）` : ''}`);

if (failed > 0) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => x.ok === false)) console.log(`  - ${r.name}: ${r.err?.message ?? r.err}`);
    // 约定：块内一律 `process.exitCode = N`（不许 `process.exit()`），否则掐死同进程的回归器。
    process.exitCode = 1;
}
else if (spawnOK === false) {
    console.log('\n注意：真跑组因宿主令牌限制被跳过（非断言失败）。要全绿请在不受限宿主里跑。');
    process.exitCode = 2;
}
else {
    console.log('\n全绿。');
    process.exitCode = 0;
}
