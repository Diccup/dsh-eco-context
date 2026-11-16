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
 * verify/all-blocks.mjs — 17 块全量回归（一道门跑完所有块的自验）
 *
 * 干什么：按块顺序跑各块 `selftest.mjs`，汇总 PASS/FAIL。
 * 跑法：node engine/verify/all-blocks.mjs  ｜ 退出码：全绿 0，有红 1。
 *
 * ★ 两次翻车后定下来的三条设计（2026-11-03）：
 *   ① 不用 `spawn` 子进程：本机沙箱下捕获子进程 stdout 会 EPERM（受限令牌不能开命名管道）。
 *   ② 不用裸 `await import()`：某块若调 `process.exit()`，会**掐死整个回归器**，
 *      后面的块和汇总行根本不执行 —— "红"伪装成"跑到第 N 项就没了"（qfmodel 抓到的）。
 *   ③ 所以：**拦截 `process.exit`**，把它变成 `process.exitCode = n` + 抛一个标记错误，
 *      让回归器能继续跑下一块。同时用 `process.exitCode` 累积结论。
 *      （块自己也不该调 process.exit —— 这条写进 selftest 约定，见 verify/README.md）
 */

import fs from 'node:fs';
import { makeTempRunDir } from '../libs/tempdir.js';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);

const ORDER = [
    'libs/sql.selftest.mjs',
    'blocks/01-core/selftest.mjs', 'blocks/02-project/selftest.mjs',
    'blocks/03-storage/selftest.mjs', 'blocks/04-store/selftest.mjs',
    'blocks/05-analyze/selftest.mjs', 'blocks/06-gram/selftest.mjs',
    'blocks/07-tokenize/selftest.mjs', 'blocks/08-writer/selftest.mjs',
    'blocks/09-reader/selftest.mjs', 'blocks/10-recall/selftest.mjs',
    'blocks/11-memory/selftest.mjs', 'blocks/12-lifecycle/selftest.mjs',
    'blocks/13-sandbox/selftest.mjs', 'blocks/14-tools/selftest.mjs',
    'blocks/15-hooks/selftest.mjs', 'blocks/16-entry/selftest.mjs',
    'blocks/17-plugs/selftest.mjs',
];

/** 标记错误：某块调 process.exit(n) 时由拦截器抛出，用于把"进程要死"变成"这一项红"。 */
class BlockExit extends Error {
    constructor(code) { super(`block called process.exit(${code})`); this.code = code; this.__blockExit = true; }
}

/** 已知"受限宿主下允许 SKIP"的块：它们 exit 2 = SKIP（不是断言失败）。 */
const SKIPPABLE = new Set(['13-sandbox']);

const results = [];

async function runOne(rel) {
    const abs = path.join(ENGINE, rel);
    const label = rel.replace('blocks/', '').replace('/selftest.mjs', '').replace('libs/', '').replace('.selftest.mjs', '(libs)');
    if (!fs.existsSync(abs)) {
        results.push({ label, ok: false, ms: 0, summary: '缺 selftest' });
        console.log(`✗ ${label.padEnd(14)}   缺 selftest.mjs`);
        return false;
    }

    // ★ 拦截 process.exit：块里一旦调用，就不许掐死整个回归器
    const realExit = process.exit.bind(process);
    let intercepted = null;
    process.exit = (code = 0) => {
        intercepted = typeof code === 'number' ? code : 0;
        throw new BlockExit(intercepted);
    };

    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };

    const savedExitCode = process.exitCode ?? 0;
    const t0 = Date.now();
    let ok = true;
    let summary = '';
    try {
        process.exitCode = 0;
        await import(pathToFileURL(abs).href + `?t=${Date.now()}`);   // 加 query 避免模块缓存
        // ★ exit 2 = SKIP（受限宿主无匿名管道，13-sandbox 的设计内行为）；其余非 0 才算红
        const code = process.exitCode ?? 0;
        ok = (code === 0 || (code === 2 && SKIPPABLE.has(label))) && intercepted === null;
        if (code === 2 && SKIPPABLE.has(label)) summary = 'SKIP（受限宿主：真跑组需不受限令牌）';
    }
    catch (e) {
        if (e instanceof BlockExit) {
            // exit 2 = SKIP（受限宿主下的设计内行为，不算红）；其余 exit ≠ 0 才算红
            ok = e.code === 0 || (e.code === 2 && SKIPPABLE.has(label));
            summary = `块内调了 process.exit(${e.code}) —— 回归器已拦截，请看该块自身输出`;
        }
        else {
            ok = false;
            summary = `${e.name}: ${String(e.message).split('\n')[0]}`;
        }
    }
    finally {
        console.log = origLog;
        console.error = origErr;
        process.exit = realExit;
        process.exitCode = savedExitCode;
    }

    const ms = Date.now() - t0;
    if (!summary) {
        summary = logs.slice().reverse().find((l) => /项全绿|断言全绿|全绿 ✅/.test(l))?.trim()
            ?? (ok ? '(无汇总行)' : '(失败无输出)');
    }
    results.push({ label, ok, ms, summary, exitIntercepted: intercepted });
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(14)} ${String(ms).padStart(6)} ms  ${summary}`);
    if (!ok) {
        for (const l of logs.slice(-10)) console.log(`      │ ${l}`);
    }
    return ok;
}

console.log('── 全量回归 ──');
for (const rel of ORDER) await runOne(rel);

// 入口 G1 单独一步
console.log('── 入口 G1 ──');
const g1t0 = Date.now();
let g1ok = false;
let g1detail = '';
try {
    const mod = await import(pathToFileURL(path.join(ENGINE, 'index.mjs')).href + `?t=${Date.now()}`);
    const engine = await mod.createEngine({ level: 'error', tempDir: makeTempRunDir('all-blocks') });
    const ready = engine.blocks.length === mod.BLOCK_MANIFEST.length && engine.missingBlocks.length === 0;
    const cloneable = JSON.parse(JSON.stringify(engine.opCatalog)).length;
    // ★ 2026-11-09 ④步 CTX 净身：14 → 13（op:search 迁 FP，净身版 §三-3/§三-2）。
    g1ok = ready && cloneable === 13;
    g1detail = `17块=${ready} 13op=${cloneable}`;
}
catch (e) {
    g1detail = `${e.name}: ${e.message}`;
}
results.push({ label: 'G1(entry)', ok: g1ok, ms: Date.now() - g1t0, summary: g1detail });
console.log(`${g1ok ? '✓' : '✗'} G1(entry)      ${String(Date.now() - g1t0).padStart(6)} ms  ${g1detail}`);

const failed = results.filter((r) => !r.ok);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n${'─'.repeat(64)}`);
console.log(`合计 ${results.length} 项 / 失败 ${failed.length} / 总耗时 ${(totalMs / 1000).toFixed(1)}s`);
// ★ 汇总行无论如何都会打出来（哪怕前面有块调了 exit）
if (failed.length > 0) {
    console.log('失败项：' + failed.map((f) => f.label).join(', '));
    process.exitCode = 1;
}
else {
    console.log('全量回归 全绿 ✅');
}
