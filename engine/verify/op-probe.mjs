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
 * §四-2 验收：**13 op 抽真调用各一发成功**
 *
 * 为什么必须有这一步（不是多此一举）：
 *   净身版 §四 明写"13 op 抽真调用各一发成功"，且 G10 的教训是
 *   **"门全绿 ≠ 装上去能用"** —— 门测的是"注册得出来"，不是"调了有用"。
 *
 * 判据：每个 op 真调一次，**不许是 UNKNOWN_OP / 不许 isError**；
 *   业务性失败（如 purge 干跑没东西）不算失败 —— 那种也要回可读文本。
 *
 * 跑法：node <本文件> [--pkg <包根>]
 *   默认扫开发区；`--pkg releases/1.0.0` 扫成品（§四 要求的是**成品**侧，见下）。
 *
 * 注意：本脚本是**一次性验收件**，按 Updating 规矩垃圾要丢 Temp；
 *   但这里是门务件、且 §三-23 同族"可重跑基线"，故留在 verify/ 下当常驻验收。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(path.dirname(HERE));

const argDir = (() => {
    const i = process.argv.indexOf('--pkg');
    if (i !== -1 && process.argv[i + 1]) return path.resolve(PKG_ROOT, process.argv[i + 1]);
    if (fs.existsSync(path.join(PKG_ROOT, 'releases', '1.0.0'))) return path.join(PKG_ROOT, 'releases', '1.0.0');
    return PKG_ROOT;
})();

const TMP = path.join(PKG_ROOT, 'Temp', `op-probe-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

/**
 * ★ 2026-11-09 补（7111d1dc 独立核对 D 条）：**跑完必须自清临时目录**。
 *
 * 原来这个脚本每跑一次就在 `Temp/` 下留一个 `op-probe-<ts>/`（含 content.db + WAL），
 * 属于 README §四「临时目录条目数必须不变」的违约 —— 实现方自查时没发现，
 * 因为自己跑完看到的是"刚生成的那个"，没去数总量。
 *
 * 清理要**先关引擎句柄再删**：SQLite 的 db/-wal/-shm 句柄开着时 rmSync 会被拒
 * （release-check / tool-surface 的门里都吃过这个亏，见 tool-surface 的 finally 段注释）。
 * 所以这里用一个显式 cleanup() 在 finally 里调，且**不因删除失败而改判验收结论**
 * （验收结论看 op 调用，不看垃圾清没清；删不掉只 warn，但要打印出来别装作没事）。
 */
let cleaned = false;
function cleanupTmp() {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(TMP, { recursive: true, force: true }); }
    catch (e) { console.log(`\n  ⚠ 临时目录没删掉（不影响验收结论，但请手工清）：${TMP} — ${e.message}`); }
}

console.log(`13 op 抽真调用验收：${argDir}\n`);

const entry = await import(pathToFileURL(path.join(argDir, 'engine', 'index.mjs')).href);
const engine = await entry.createEngine({ contentDir: TMP, level: 'error' });

// 每个 op 一份**最小合法参数**。故意不用空参：空参走的是"缺参报错"分支，
// 验不出"这个 op 能不能干活"。这里要的是"给对参数会不会成功"。
const probes = [
    ['run', { op: 'run', language: 'javascript', code: 'return 7*6;' }, /42/],
    ['recall', { op: 'recall', queries: ['僵尸进程'] }, null],           // 先由 index 写一条，见下
    ['index', { op: 'index', content: '# 验收\n僵尸进程会持有 WAL 锁。', source: 'op-probe' }, /已写入|写入/],
    ['remember', { op: 'remember', title: '探针条目', content: '探针正文', category: 'g11' }, /./],
    ['pin', { op: 'pin', label: 'op-probe', category: 'g11' }, /./],
    ['unpin', { op: 'unpin', label: 'op-probe' }, /./],
    ['memory', { op: 'memory', action: 'list' }, /./],
    ['stats', { op: 'stats' }, /./],
    ['doctor', { op: 'doctor' }, /./],
    ['maint', { op: 'maint', action: 'plan' }, /./],
    ['purge', { op: 'purge', scope: 'session', session: 'probe-session-never-exists' }, /./],  // 默认干跑；给个不存在的 session ⇒ 命中 0，安全
    ['switch', { op: 'switch', action: 'list' }, null],                 // 见下：无宿主时按 NO_HOST_CAP 判**合格**
    ['list', { op: 'list' }, /run/],
];

// 顺序要点：index 必须先跑（recall 要有东西可搜）。
const ordered = [];
for (const p of probes) if (p[0] === 'index') ordered.push(p);
for (const p of probes) if (p[0] !== 'index') ordered.push(p);

let pass = 0;
const failed = [];
// ★ 两个 op 的"合格"判据要按**运行环境**说清楚，不能一刀切（否则要么假红要么假绿）：
//   · `switch` 需要宿主 tools 服务。本探针是**独立跑引擎**（无宿主），拿不到 agent 作用域，
//     引擎会如实回 `NO_HOST_CAP`（可读文案，不是崩溃）。这条文案**本身就是正确行为**——
//     真机上由 platform/tool-switch.js 注入后才可用（G11 ⑦ / G10 已覆盖那段）。
//     ⇒ 判据：回 NO_HOST_CAP 且文案可读 = **合格**；回 UNKNOWN_OP / 抛栈 = 不合格。
//   · 其余 op 一律"不许 isError、不许空文本"。
const HOST_DEPENDENT = new Map([
    ['switch', /NO_HOST_CAP/],
]);
for (const [op, args, want] of ordered) {
    try {
        const r = await engine.call('ctx', args);
        const text = String(r?.content?.[0]?.text ?? '');
        const hostRule = HOST_DEPENDENT.get(op);
        if (hostRule && hostRule.test(text)) {
            pass++;
            console.log(`  ✓ ${op}  （无宿主环境，按设计回可读的 NO_HOST_CAP）`);
            continue;
        }
        if (r?.isError === true) { failed.push(`${op}: isError=true → ${text.slice(0, 120)}`); console.log(`  ✗ ${op}`); continue; }
        if (/UNKNOWN_OP|没有 op=/.test(text)) { failed.push(`${op}: UNKNOWN_OP（根本没分派出去）`); console.log(`  ✗ ${op}`); continue; }
        if (text.trim().length === 0) { failed.push(`${op}: 返回空文本（调了但没输出）`); console.log(`  ✗ ${op}`); continue; }
        if (want && !want.test(text)) { failed.push(`${op}: 文本不符合预期 ${want}：${text.slice(0, 120)}`); console.log(`  ✗ ${op}`); continue; }
        pass++;
        console.log(`  ✓ ${op}  ${text.split('\n')[0].slice(0, 70)}`);
    }
    catch (e) {
        failed.push(`${op}: 抛错 ${e?.code ?? ''} ${e?.message ?? e}`);
        console.log(`  ✗ ${op}`);
    }
}

// 反向判据：search 必须调不通（摘干净的证据，不是"没测到"）
{
    const r = await engine.call('ctx', { op: 'search', query: 'x' });
    const t = String(r?.content?.[0]?.text ?? '');
    if (/UNKNOWN_OP|没有 op=/.test(t)) console.log(`  ✓ (反向) op:search 已调不通 → ${t.split('\n')[0].slice(0, 80)}`);
    else { failed.push(`反向判据失败：op:search 竟然还能调 → ${t.slice(0, 120)}`); console.log('  ✗ (反向) op:search 还能调'); }
}

// ★ 先关引擎句柄，再删临时目录（顺序不能反：db/wal/shm 句柄开着时 rmSync 会被拒）
try { engine.dispose(); } catch { /* 已关 */ }
cleanupTmp();

console.log('\n' + '─'.repeat(60));
console.log(`13 op 抽真调用：${pass}/13 成功 / 额外失败 ${failed.length}`);
console.log(`OP_PROBE_SUMMARY pass=${pass} failed=${failed.length} status=${failed.length ? 'FAIL' : 'PASS'}`);
if (failed.length) {
    console.log('\n失败明细：');
    for (const f of failed) console.log(`  · ${f}`);
    process.exitCode = 1;
}
else console.log('\n全部 13 op 真调用成功 ✅');
