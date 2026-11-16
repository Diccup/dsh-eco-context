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
 * verify/install-slot-check.mjs — 装机槽一致性门（2026-11-04 S9.28 事故后新增）
 *
 * ★ 编号：**故意不编号**。维护方 2026-11-04 21:1x 明确否掉过实现方擅自新加的「G12」门
 *   （见 Updating/03-开发日志.md「越权事故」条），并立下纪律「加这类判据必须先问维护方」。
 *   实现方本轮又险些占用 G12 —— 已改名为不编号的 `install-slot-check`。
 *   **要不要把它升格成正式编号门，等设计确定：，实现方不自行编号。**
 *
 * 为什么必须单独有这一道
 * ─────────────────────────────────────────────────────────
 * 事故现场（2026-11-04 22:44 维护方重启后）：
 *
 *   活槽 `profiles\desktop\node_modules\dsh-eco-context` 缺 `ours/python-find.js`，
 *   而 `ours/ws-transport.js` 里写着 `import { findPython } from './python-find.js'`。
 *
 *   这一处缺件的杀伤力**远超"某个 op 失败"**——它是启动即死：
 *
 *     python-find.js 缺失
 *       → ws-transport.js 的 import 解析失败
 *       → ours/web-search.js           （顶层静态 import ws-transport）
 *       → platform/engine-client.js    loadWebModule()  ← initialize() 里，无兜底
 *       → platform/plugin.js:220       openTransport() 抛
 *       → plugin.js:278 catch          toolCount === 0 → client?.shutdown()
 *       → 工具面 0 个工具，ctx 整个消失，日志只有一行 warn
 *
 *   更隐蔽的是：**G9⑩ 扫的是发布包（releases/1.0.0），那里是齐的、全绿**。
 *   缺件发生在**装机槽**——pnpm 的 `file:` 依赖是**硬链接复制**：
 *   改老文件两处同变（所以 R1/R2/R3/R15 在活槽里都是对的），
 *   但**新增文件永远补不进去**，重写过的文件还会脱链。
 *   只跑 robocopy 到 `plugins\` 而不同步 `node_modules\`，就是这个结果。
 *
 * 这一道门断言三件事
 * ─────────────────────────────────────────────────────────
 *   ① 两个装机槽的文件清单一致（活槽允许多出 `.content\*.db` 活库文件）
 *   ② 同名文件 SHA256 逐件一致（多出/不同都算失败）
 *   ③ **启动路径上的模块在活槽里真的能 import**
 *      —— 清单里必须包含 `ours/web-search.js`：它是 `initialize()` 里的静态 import，
 *         不是懒加载。只 import `platform/plugin.js` 会漏（实现方本轮就漏过）。
 *
 * 跑法：node engine/verify/install-slot-check.mjs
 * 边界：**只读**。不写任何槽、不建库、不动数据。
 *       两槽任一不存在 → 跳过（不算失败），因为开发机上可能还没装。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

/** 两个装机槽。槽 A 是 robocopy/pnpm 的源；**槽 B 才是 DSH 进程实际加载的那份**。 */
const SLOT_A = path.join(os.homedir(), '.dsh', 'plugins', 'dsh-eco-context');
const SLOT_B = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-eco-context');

/**
 * 活槽里允许独有的文件（运行期数据，不属于代码）。
 *
 * ★ 2026-11-07 N6：加 `fp/out/`。
 *   `fp/support/config.py:13` 定 `out_dir = BASE/"out"`（BASE = `fp/`），fp 腿每跑一次
 *   就在**活槽**里落页面缓存。它删了还会重建，属于纯运行时产物。
 *   维护方决定：「既然有不能删，删了还会重建，那就直接放弃检测这个」
 *   ⇒ **只加排除、不删文件、不搬 out_dir**。这门从此不报 fp/out 为"多余件"。
 */
const LIVE_ONLY = [
    /^engine[\\/]\.content[\\/].*\.db(-wal|-shm)?$/i,
    /^fp[\\/]out[\\/]/i,
    // ★ 2026-11-09 ④步 CTX 净身 S1：加 `fp/diag/`。
    //   与上面 `fp/out/` **完全同型**（N6 判例）：`fp/support/config.py` 把 diag 定成
    //   运行期落盘目录，抓取触发拦截就写一份 `cf_blocked_<ts>.txt`，
    //   **删了下次跑还会重建** ⇒ 维护方既有口径「既然有不能删，删了还会重建，那就直接放弃检测这个」
    //   直接适用：只加排除、不删文件、不搬目录。
    //   实证（2026-11-09）：活槽内 2 件 `cf_blocked_20261108_1712{14,17}.txt`（各 106 B，
    //   内容 state=blocked / body_len=55 / token=False），源槽与开发树均无此件 = 纯运行期产物，
    //   非代码漂移，也非本次拆 search 造成（同族红项本轮之前已由
    //   `Oldversion\02-结构图刷新至1108实况` L4 记过）。
    //   注：§三-24 把 `fp/` 整层移出 CTX 后，本条将成为历史（保号不删，防复现）。
    /^fp[\\/]diag[\\/]/i,
];

/**
 * 启动路径上必须能 import 的模块（相对包根）。
 *
 * ★ 顺序有讲究：从"最外层入口"排到"最里层依赖"，第一个炸的就是根因。
 *
 * ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-14，07c D18-13/15）：12 条 → **7 条**。
 * ★★ 2026-11-14（项目 07）：7 条 → **6 条**（道 A `ours/recall-hints.js` 退役删件）。
 *   按"走 5 / 留 6"逐条重排（**注意：开头 12 条里 5 条走掉，剩 6 条 + engine/index.mjs
 *   = 实测 7 条**；实现方第一版把这里写成"12 → 11"，是错的 —— 由某次实测 独立核对
 *   抓出「STARTUP 记账写 12→11，实测 12→7（功能对、文档错）」，2026-11-09 已改准）：
 *     · 走 5：web-search.js / ws-transport.js / ws-engines.js / fp-bridge.js / python-find.js
 *       —— 全部随 op:search 迁 FP，CTX 包里已无此件（留在清单里就是启动路径必红）。
 *     · 留 5：plugin.js / engine-client.js / output-containment.js / precompact.js /
 *       session-memory.js。
 *     · 外加 engine/index.mjs（引擎入口，原本就在列，不属"留 5"那批 ours 件）。
 *     · `output-containment.js` **留 CTX 但仍在启动路径**（plugin.js 挂着它做 post-execute：
 *       溢出截断 + ★2026-11-14 起还做「全工具输出入库」）。
 *
 *   ★★ 2026-11-14（项目 07）：`recall-hints.js`（道 A）**已退役并删件** ⇒
 *     启动路径从 7 条降回 **6 条**（"留 6"→"留 5"）。清单里留它 = 启动路径必红。
 *   原文（已留底 BACKUP\engine\verify\install-slot-check.mjs）见下方历史注记。
 */
const STARTUP_MODULES = [
    'platform/plugin.js',        // 宿主入口（package.json main）
    'platform/engine-client.js', // 装配引擎（★ 净身：loadWebModule() 已移除，见 §三-15）
    'ours/output-containment.js',// 溢出保护 + 全工具输出入库（plugin.js 挂 post-execute，CTX 自用）
    'ours/precompact.js',        // 压缩归档
    'ours/session-memory.js',    // 会话记忆（道 A 退役后只剩道 B 与归档指针）
    'engine/index.mjs',          // 引擎入口
];

/**
 * ★ 历史注记（原 STARTUP_MODULES 头部，2026-11-09 净身时保留下来的教训，别删）：
 *
 *   「`ours/web-search.js` 必须在列 —— 它在 `EngineClient.initialize()` 里被静态拉起，
 *    断了就等于插件失活，而这一点曾让实现方误判成"懒加载，只有搜网页才炸"。」
 *
 *   2026-11-03 的真事故（本门因此存在）：活槽缺 `ours/python-find.js`，而
 *   `ours/ws-transport.js` 里写着 `import { findPython } from './python-find.js'`：
 *     python-find.js 缺失 → ws-transport.js import 解析失败 → web-search.js（顶层静态
 *     import ws-transport）→ initialize() 里静态拉起的整条链断裂 = 插件整体失活。
 *   ★ 净身之后这条链已整体搬到 FP：CTX 启动路径不再有 python-find/ws-transport/web-search。
 *     **但教训不因拆插件失效** —— FP 侧必须重立同型"启动路径 import 门"，
 *     否则同一个坑会在新包里再踩一次（这正是净身版 §二"纪律与教训不因拆插件失效"的含义）。
 */

const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');

/** 递归列出所有文件（相对路径，正斜杠）。 */
function listFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '__pycache__') continue;
                walk(p);
                continue;
            }
            out.push(rel(root, p));
        }
    };
    walk(root);
    return out.sort();
}

const sha256 = async (file) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};

const results = [];
const check = async (label, fn) => {
    try {
        await fn();
        results.push({ label, ok: true });
        console.log(`  ✓ ${label}`);
    }
    catch (e) {
        results.push({ label, ok: false, error: e?.message ?? String(e) });
        console.log(`  ✗ ${label}\n      ${(e?.message ?? String(e)).split('\n').join('\n      ')}`);
    }
};

const main = async () => {
    console.log('装机槽一致性自检\n');

    const hasA = fs.existsSync(SLOT_A);
    const hasB = fs.existsSync(SLOT_B);

    if (!hasA || !hasB) {
        console.log(`  ⊘ 跳过：槽 A ${hasA ? '在' : '缺'} / 槽 B ${hasB ? '在' : '缺'}（开发机上可能还没装）`);
        console.log('\n跳过（不算失败）');
        return;
    }

    console.log(`  槽 A（源）  : ${SLOT_A}`);
    console.log(`  槽 B（活的）: ${SLOT_B}\n`);

    let listA = [];
    let listB = [];

    await check('① 两槽文件清单一致（活槽只许多 .content\\*.db 活库文件）', () => {
        listA = listFiles(SLOT_A);
        listB = listFiles(SLOT_B);
        const setA = new Set(listA);
        const setB = new Set(listB);
        const missing = listA.filter(f => !setB.has(f));      // A 有 B 没有 = 装机缺件（致命）
        const extra = listB.filter(f => !setA.has(f) && !LIVE_ONLY.some(re => re.test(f)));
        if (missing.length > 0) {
            throw new Error(
                `活槽缺 ${missing.length} 件（pnpm file: 硬链接补不进新增文件 —— 必须重跑 pnpm add）：\n`
                + missing.slice(0, 10).map(f => `  - ${f}`).join('\n'),
            );
        }
        if (extra.length > 0) {
            throw new Error(`活槽多出 ${extra.length} 件非数据文件（成品不干净）：\n`
                + extra.slice(0, 10).map(f => `  + ${f}`).join('\n'));
        }
    });

    await check('② 同名文件 SHA256 逐件一致（脱链 = 内容漂移）', async () => {
        const setB = new Set(listB);
        const diffs = [];
        for (const f of listA) {
            if (!setB.has(f)) continue;   // ① 已报
            const a = await sha256(path.join(SLOT_A, f));
            const b = await sha256(path.join(SLOT_B, f));
            if (a !== b) diffs.push(f);
        }
        if (diffs.length > 0) {
            throw new Error(`有 ${diffs.length} 件内容不同（硬链接已断，改一处不再两处同变）：\n`
                + diffs.slice(0, 10).map(f => `  ≠ ${f}`).join('\n'));
        }
    });

    // ★ ③ 是这一道门的真正价值：清单一致也可能 import 炸（比如路径大小写、循环依赖）。
    //   ★ 2026-11-09 净身：原判据名写"（含 ours/web-search.js）"—— 该件已随 op:search 迁 FP，
    //     清单里早没它了；标题还挂旧件名会让读的人以为这门仍在查它（**文案撒谎**，§三-7 同族）。
    //     现按实际清单表述：走 5 / 留 6 + engine/index.mjs。
    await check('③ 启动路径上的模块在活槽里真能 import（按 STARTUP_MODULES 实际清单）', async () => {
        const bad = [];
        for (const m of STARTUP_MODULES) {
            const abs = path.join(SLOT_B, m);
            if (!fs.existsSync(abs)) { bad.push(`${m} → 文件不存在`); continue; }
            try {
                await import(pathToFileURL(abs).href);
            }
            catch (e) {
                const code = e?.code ? `${e.code}: ` : '';
                bad.push(`${m} → ${code}${String(e?.message ?? e).split('\n')[0]}`);
            }
        }
        if (bad.length > 0) {
            throw new Error(`${bad.length}/${STARTUP_MODULES.length} 个启动模块加载失败`
                + `（任何一个都会让插件整体失活）：\n` + bad.map(s => `  × ${s}`).join('\n'));
        }
    });

    // ★ N8 批次 1 · D3（票面 11 v0.5；只动门③这一处）：**卡片 import 也纳入 ③**。
    //   风险（某次实测 判读）= ③ 只 import 被点名件 ⇒ 没点名的卡 import 坏了要到运行时
    //   才炸（R11 同族病）。做法 = **扫 SLOT/ours/engines/ 目录逐个 import，不手写 17 个
    //   文件名**（手写名单又是同族病复发源）；**engines-offline/ 不进**（02 v1.3 钉死项 7：
    //   离线卡永不 import）。STARTUP_MODULES 12 条平铺不动。
    //   时序（S3-S6 不动装机槽的铁律）：批次 1 结案维护方重装前，槽里还没有 engines/ ⇒
    //   **目录缺失 = warn 跳过（不跑红）**；重装后此门自动收紧成真扫。
    //   口径衔接（v0.6）：本门扫的是**槽内 SLOT_B**；D4 三门扫的是**成品侧**——两处对象不同。
    await check('③b 槽内 engines/ 卡片逐个能 import（扫目录不点名；缺目录 warn 跳过）', async () => {
        const cardsDir = path.join(SLOT_B, 'ours', 'engines');
        if (!fs.existsSync(cardsDir)) {
            console.log(`  ! 跳过：槽内卡片目录不存在（批次 1 结案重装前属预期）：${cardsDir}`);
            return;
        }
        const bad = [];
        const cards = fs.readdirSync(cardsDir).filter((n) => n.endsWith('.js')).sort();
        for (const f of cards) {
            const abs = path.join(cardsDir, f);   // 槽内绝对路径；不用相对 import.meta.url
            try {
                await import(pathToFileURL(abs).href);
            }
            catch (e) {
                const code = e?.code ? `${e.code}: ` : '';
                bad.push(`ours/engines/${f} → ${code}${String(e?.message ?? e).split('\n')[0]}`);
            }
        }
        if (bad.length > 0)
            throw new Error(`${bad.length}/${cards.length} 张槽内卡片 import 失败（未点名 = 运行时才炸）：\n`
                + bad.map(s => `  × ${s}`).join('\n'));
        console.log(`  ✓ ③b 扫到 ${cards.length} 张卡（${cardsDir}）全部 import 通过`);
    });

    // ★ ④ 2026-11-05 真机事故补的门：**活槽里的 cordis.patch.yml 必须是 insert 形状**。
    //   为什么必须验"装好之后的那份"而不是只验成品：事故里成品与两个槽是**同时**被写坏的
    //   （装配脚本兜底模板错形状 → 一路拷进槽），任何只验开发树的门都看不见。
    //   bundle patch 形状错的后果不是"少点功能"：patch 整行不生效 → 插件不挂载 →
    //   工具面全空；宿主里同 id 的配置行失去宿主，连带把同源部署一起打死。
    //   真机表现：维护方说明"你为啥把我 CTX 弄没了 / 另一个 context 插件也不能用了"。
    await check('④ 两槽的 cordis.patch.yml 都是 insert 形状（bundle patch 真会被装载）', async () => {
        const bad = [];
        for (const [label, slot] of [['槽 A（源）', SLOT_A], ['槽 B（活的）', SLOT_B]]) {
            const p = path.join(slot, 'cordis.patch.yml');
            if (!fs.existsSync(p)) { bad.push(`${label}: 缺 cordis.patch.yml`); continue; }
            const yml = fs.readFileSync(p, 'utf8');
            const lines = yml.split(/\r?\n/);
            const why = [];
            const insertAt = lines.findIndex(l => /^- insert:\s*$/.test(l));
            if (insertAt < 0) why.push('缺顶层 "- insert:"');
            if (lines.some(l => /^- id:/.test(l))) why.push('有顶格 "- id:"（id 必须在 insert 之下）');
            const rowAt = lines.findIndex(l => /^\s{4}- id:\s*dsh-eco-context\s*$/.test(l));
            if (rowAt < 0) why.push('insert 下缺 4 空格的 "- id: dsh-eco-context"');
            else if (insertAt >= 0 && rowAt < insertAt) why.push('"- id:" 在 insert 之前');
            if (!/^\s{6}name:\s*'?"?dsh-eco-context'?"?\s*$/m.test(yml)) why.push("缺 6 空格的 \"name: 'dsh-eco-context'\"");
            if (!/inject:\s*\[[^\]]*\btools\b/.test(yml)) why.push('缺 inject: [tools, ...]');
            if (why.length > 0) bad.push(`${label}: ${why.join('；')}`);
        }
        if (bad.length > 0) {
            throw new Error('cordis.patch.yml 形状不对 —— 装上去插件不会挂载（工具面会全空）：\n'
                + bad.map(s => `  × ${s}`).join('\n'));
        }
    });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`装机槽自检：${results.length} 项 / 失败 ${failed.length}`);
    if (failed.length > 0) {
        console.log('失败：' + failed.map(f => f.label).join(' | '));
        process.exitCode = 1;
    }
    else {
        console.log('装机槽自检 全绿 ✅ —— 两槽一致，启动路径全部可加载');
    }
    // ★★ 2026-11-09 补（某次实测 独立核对 C 条）：**把本门的证明力边界打在输出里**，
    //   防后来人把这条绿当成"新包可以装了"的证据。
    //   事实：本门比的是**两个装机槽**（槽 A 源 / 槽 B 活），两槽都还是**上一次装进去的那份**。
    //   如果在开发树改完、还没重装就跑本门，它自证的是"旧槽对旧槽一致"——
    //   **绿 != 新代码可装**。新代码能不能装，归 install-path.mjs（G10，不注入接缝走真实解析）
    //   + release-check.mjs（G9，在成品目录里验）+ 维护方重装后的真机调用。
    //   实证（2026-11-09 净身施工期间）：两槽都仍是净身前旧 14-op 件（含 ours/web-search.js
    //   与 17 张卡），而本门 5 项全绿 —— 正是"旧槽对旧槽"的活样本。
    console.log('说明：本门只证"两槽一致 + 启动路径可加载"，**不证新包可装**；');
    console.log('      新代码能否装 → 看 G10 install-path + G9 release-check + 重装后真机调用。');
};

await main();
