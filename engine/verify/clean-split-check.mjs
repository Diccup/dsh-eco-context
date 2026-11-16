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
 * 拆干净机检 —— §三-23（净身版《三方讨论结果-三堆分类-CTX净身版-20261109.md》§三第 23 条）
 *
 * 干什么：**全仓 import 图谱扫描**，证明 CTX 侧对 FP 的件"零引用残留"。
 * 为什么要有它：净身版 §16.2-④ 要求"拆接口干净"从**人工核账**升级为**可重跑基线**。
 *   人工核账的通病是"我看着像没了"；`§三-12` 那句"漏一处 = 假绿"就是这个病的名字。
 *
 * ── 判据（三条全过才算拆干净）─────────────────────────────────────────
 *   ① **禁止清单目录不许存在**（在开发树 / 成品 / 活槽任一处都不该有 FP 的件）：
 *        overlay/ours/{web-search,ws-transport,ws-engines,ws-text,ws-detect,ws-media,
 *                      fp-bridge,python-find}.js
 *        overlay/ours/engines/、overlay/ours/engines-offline/
 *        成品根 deps/、fp/
 *   ② **活代码不许 import 它们**（注释与文档字符串不算 —— 见下"剥注释"规矩）
 *   ③ **文档面不许教它们**（skills/*.md 里不许出现 op:search 的调用式教学；
 *      允许出现在 no-longer-exists / 已迁 FP 语境）
 *
 * ── 为什么判据要"剥注释再判"（这是踩过的坑，不是洁癖）──────────────
 *   `release-check.mjs` ⑩ 的原注写得很清楚：
 *     "先剥掉注释：注释里的 `import '../ours/x.js'` 是**文档示意**，不是真 import
 *      （layout.js:11 就写着这么一句，第一版判据把它当漏件报了）。"
 *   本脚本沿用同一规矩：判据宁可窄一点，只认真代码里的相对 import。
 *
 * ── 白名单（设计内，别当残留清理）─────────────────────────────────
 *   `engine/libs/url-guard.js` 与 `engine/libs/err.js`：v2.2 §一-4 双留口径 ——
 *   FP 拿一份、CTX 原件**留守不删**，呈"0 引用死代码待复活引回"状态。
 *   净身版 §三-2 括注明写"属设计内，别当残留清理"。
 *   ⇒ 本脚本对这两件**只报引用计数、不判失败**（下面打印 info 行）。
 *
 * 跑法：node engine/verify/clean-split-check.mjs [--dir <包根>]
 *   默认扫开发区（本仓根）；`--dir releases/1.0.0` 扫成品。
 * 退出码：0 = 拆干净；1 = 有残留（逐条列出来，不汇总掩盖）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(path.dirname(HERE));

const argDir = (() => {
    const i = process.argv.indexOf('--dir');
    if (i !== -1 && process.argv[i + 1]) return path.resolve(PKG_ROOT, process.argv[i + 1]);
    return PKG_ROOT;
})();

/** 随 op:search 迁 FP 的平铺件（8 件）。 */
const MOVED_PLAIN = [
    'web-search.js', 'ws-transport.js', 'ws-engines.js', 'ws-text.js',
    'ws-detect.js', 'ws-media.js', 'fp-bridge.js', 'python-find.js',
];
/** 随迁的两个卡片目录（24 卡）。 */
const MOVED_CARD_DIRS = ['engines', 'engines-offline'];
/** 随迁的包体层。 */
const MOVED_PKG_DIRS = ['deps', 'fp'];

/** 双留白名单：CTX 留守不删，只报计数不判红。 */
const DOUBLE_KEEP = ['engine/libs/url-guard.js', 'engine/libs/err.js'];

/** 剥注释（块注释 + 整行行注释 + 行尾注释），只留真代码。与 release-check ⑩ 同规矩。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/[ \t]+\/\/.*$/gm, '');
}

/** 递归列 .js/.mjs 文件（相对路径，正斜杠），跳过 node_modules/__pycache__/ref/backups。 */
function listCode(root, skip = ['node_modules', '__pycache__', 'ref', 'backups', 'Updating', 'releases']) {
    const out = [];
    const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (skip.includes(e.name)) continue;
            const p = path.join(dir, e.name);
            const r = `${rel}${e.name}`;
            if (e.isDirectory()) { walk(p, `${r}/`); continue; }
            if (!/\.(js|mjs)$/.test(e.name)) continue;
            out.push(r);
        }
    };
    walk(root, '');
    return out.sort();
}

const failures = [];
const infos = [];
const ok = [];

const fail = (msg) => { failures.push(msg); console.log(`  ✗ ${msg}`); };
const pass = (msg) => { ok.push(msg); console.log(`  ✓ ${msg}`); };
const info = (msg) => { infos.push(msg); console.log(`  ⓘ ${msg}`); };

console.log(`拆干净机检（§三-23）：${argDir}\n`);

// ─────────── ① 禁止清单：FP 的件不许还在 ───────────
console.log('【① FP 的件不许还在（开发树/成品/活槽任一位置）】');
{
    const oursDir = fs.existsSync(path.join(argDir, 'ours'))
        ? path.join(argDir, 'ours')
        : path.join(argDir, 'overlay', 'ours');
    if (!fs.existsSync(oursDir)) {
        fail(`找不到 ours/（试过 ${argDir}\\ours 与 ${argDir}\\overlay\\ours）—— 判据无法成立，不许静默跳过`);
    }
    else {
        const leftovers = MOVED_PLAIN.filter((f) => fs.existsSync(path.join(oursDir, f)));
        if (leftovers.length) fail(`ours/ 里还留着迁出件：${leftovers.join(', ')}`);
        else pass(`ours/ 平铺 8 件已清空（web-search/ws-*/fp-bridge/python-find 全无）`);

        const cardLeft = MOVED_CARD_DIRS.filter((d) => fs.existsSync(path.join(oursDir, d)));
        if (cardLeft.length) fail(`ours/ 里还留着迁出卡目录：${cardLeft.join(', ')}`);
        else pass(`ours/ 卡片目录已清空（engines/、engines-offline/ 全无 = 24 卡已迁）`);
    }

    const pkgLeft = MOVED_PKG_DIRS.filter((d) => fs.existsSync(path.join(argDir, d)));
    if (pkgLeft.length) fail(`包体还留着迁出层：${pkgLeft.join(', ') || '-'}（§三-24 乙态摘净）`);
    else pass(`包体 deps/、fp/ 已摘净（§三-24）`);
}

// ─────────── ② 活代码不许 import 它们 ───────────
console.log('\n【② 活代码不许 import 迁出件（剥注释后判，只认真 import）】');
{
    const files = listCode(argDir);
    if (files.length === 0) fail('一个 .js/.mjs 都没扫到 —— 路径不对或目录被掏空');

    // 命中形状：相对路径 import 里出现迁出件名 / 卡片目录名 / deps|fp 层
    const MOVED_RE = new RegExp(
        '(?:'
        + MOVED_PLAIN.map((f) => f.replace('.', '\\.')).join('|')
        + '|(?:^|/)(?:' + MOVED_CARD_DIRS.join('|') + ')/'
        + ')'
    );
    // deps/fp 作为"包体层"被 import 的形状（只认从包根起算的相对路径）
    const LAYER_RE = /(?:from\s*['"]|import\(\s*['"])(?:\.\.?\/)*(?:deps|fp)\//;

    const hits = [];
    for (const rel of files) {
        const abs = path.join(argDir, rel);
        let src;
        try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const code = stripComments(src);
        // 逐行找 import/export-from/动态 import 的说明符
        const specRe = /(?:^|[^\w$])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
        let m;
        while ((m = specRe.exec(code)) !== null) {
            const spec = m[1] ?? m[2];
            if (!spec || !spec.startsWith('.')) continue;   // 只认相对路径（裸包名归 FP 自己管）
            if (DOUBLE_KEEP.some((k) => spec.endsWith('/' + path.basename(k)))) continue;
            if (MOVED_RE.test(spec) || LAYER_RE.test(`from '${spec}'`)) {
                hits.push(`${rel}  →  ${spec}`);
            }
        }
    }
    if (hits.length) {
        fail(`还有 ${hits.length} 处活代码 import 迁出件：\n      ${hits.slice(0, 12).join('\n      ')}`);
    }
    else pass(`扫描 ${files.length} 个 .js/.mjs，对迁出件零 import（剥注释后）`);
}

// ─────────── ③ 文档面不许教它们 ───────────
console.log('\n【③ 文档面与平台层文案不许教 op:search】');
{
    const docs = [];
    const descDir = path.join(argDir, 'engine', 'blocks', '14-tools', 'descriptions');
    if (fs.existsSync(descDir)) {
        for (const f of fs.readdirSync(descDir)) if (f.endsWith('.md')) docs.push(path.join(descDir, f));
    }
    // ★ 技能面有两种家：开发区在 `overlay/skills/`，成品在 `skills/`（assemble-release 拷过去）。
    //   只找 `skills/` 会在开发区扫到 0 份 —— 那是**假绿**（净身版 §三-10 判别式同一类病：
    //   "门只观察到自己想看的那个位置"）。两处都扫，哪处存在扫哪处。
    const skillRoots = [
        path.join(argDir, 'overlay', 'skills'),
        path.join(argDir, 'skills'),
    ].filter((d) => fs.existsSync(d));
    if (skillRoots.length === 0) fail(`找不到技能面（试过 overlay/skills 与 skills）—— 判据无法成立，不许静默跳过`);
    for (const root of skillRoots) {
        for (const d of fs.readdirSync(root)) {
            const f = path.join(root, d, 'SKILL.md');
            if (fs.existsSync(f)) docs.push(f);
        }
    }
    // ★★ 2026-11-09 补洞（7111d1dc 独立核对 A 条）：**平台层 .js 也是"文案面"**。
    //   原判据只扫 descriptions/*.md 与 skills/*/SKILL.md，漏了 `platform/catalog.js` ——
    //   而它的 `deployNote()` 返回值会被 `skill-set.js` 注入 `ctx` 技能**正文**（有工具被禁时）：
    //     · catalog.js:60 硬编码 op 名单含 `search`、漏 `switch`
    //   ⇒ 那是一条**真正会到达模型眼前**的"教不存在的 op"，比任何 md 都直接。
    //   教训：判据的扫描面必须按"**这些东西最终会不会到模型眼前**"定，不是按"它是 .md 还是 .js"。
    const platformDir = fs.existsSync(path.join(argDir, 'platform'))
        ? path.join(argDir, 'platform')
        : path.join(argDir, 'overlay', 'platform');
    const platformJs = fs.existsSync(platformDir)
        ? fs.readdirSync(platformDir).filter((f) => f.endsWith('.js')).map((f) => path.join(platformDir, f))
        : [];

    // ★★ 2026-11-09 第二次修（0d2c6aae 驳回 A-2）：**从引擎真源取 op 清单**，供"直接对拍"用。
    //   取法用**运行时真 import**（与核对方一致），不是正则读源码 ——
    //   读源码数 op 会被注释/多行写法骗，import 拿到的就是引擎真正注册的那份。
    //   取不到就 fail-fast（判据无法成立时**不许静默跳过**，这条纪律本门已在别处立过）。
    let TRUTH_OPS = [];
    try {
        const entryUrl = pathToFileURL(path.join(argDir, 'engine', 'index.mjs')).href;
        const entry = await import(entryUrl + '?ts=' + Date.now());
        TRUTH_OPS = (entry.OP_CATALOG ?? []).map((o) => o.op);
    }
    catch (e) {
        fail(`读不到引擎 OP_CATALOG（${e.message}）—— 对拍判据无法成立，不许静默跳过`);
    }
    if (TRUTH_OPS.length === 0) fail('引擎 OP_CATALOG 是空的 —— 读法不对或引擎坏了，对拍判据不成立');
    else info(`真源基准：engine/index.mjs OP_CATALOG = ${TRUTH_OPS.length} 项 [${TRUTH_OPS.join(',')}]`);
    if (platformJs.length === 0) {
        fail(`找不到平台层 .js（试过 platform 与 overlay/platform）—— 文案面判据不完整，不许静默跳过`);
    }

    // "教"的判据（分两种文件类型，判法不同）：
    //   · md / 平台 js 里的**字符串字面量**：出现 `op:"search"` 的调用式，且不在否定/已迁语境。
    //     纯提"search 已迁 FP"这类说明句是**要求保留**的（那才是诚实文案）。
    //   · 平台 js 里还有第二种形态：**op 名单列表**（如 `run / search / recall …`）。
    //     它不写 `op:"search"`，但同样是"把这个 op 教给模型"。
    //     ⇒ 判据：平台 js 里出现独立单词 `search` 且**同行还有 ≥3 个其它 op 名** = 疑似 op 名单。
    const CALL_RE = /op\s*:\s*["']search["']/g;
    const NEGATIVE = /已迁|迁 FP|不在本插件|不含 ?SEARCH|no longer|not exist|已摘|已拆/i;
    const OPS = ['run', 'recall', 'index', 'remember', 'pin', 'unpin', 'memory', 'stats',
        'doctor', 'maint', 'purge', 'switch', 'list'];
    const offenders = [];

    for (const f of docs) {
        const text = fs.readFileSync(f, 'utf8');
        let m;
        while ((m = CALL_RE.exec(text)) !== null) {
            const win = text.slice(Math.max(0, m.index - 200), m.index + 200);
            if (NEGATIVE.test(win)) continue;
            const line = text.slice(0, m.index).split('\n').length;
            offenders.push(`${path.relative(argDir, f)}:${line}（op:"search" 调用式）`);
        }
    }
    for (const f of platformJs) {
        const raw = fs.readFileSync(f, 'utf8');
        // ★★ 2026-11-09 第二次修（0d2c6aae 驳回 A-2 条，真 bug）：
        //   **上一版判据只认"单个长字符串里含 op 名单"，抓不住数组逐元素写法。**
        //   驳回实证（0d2c6aae 三次注入）：
        //     ① KNOWN_OPS 改回**跨行数组**（真实形态，含 search 漏 switch）→ 上一版 **EXIT=0**（漏）
        //     ② 改回**单行数组**（含 search）                        → 上一版 **EXIT=0**（漏）
        //     ③ 注入**单个长字符串** 'run / search / recall / …'      → 上一版 **EXIT=1**（只抓到这条）
        //   根因：上一版在**每个字符串字面量内部**数其它 op 名（others>=3 才算名单）。
        //   而 `KNOWN_OPS` 是数组逐元素，`'search'` 自成一项 ⇒ others=0 ⇒ 永不报红。
        //   ⇒ 实现方那次"验证过真能红"**注入的形态与产品真实形态不是同一个**，等于验了另一条路径。
        //     这是 §三-12「漏一处=假绿」的**第二现场**：刚堵掉同类洞，在新判据上原样重演。
        //   **教训（已请 A 窗写进纪律）：判据的验证方法 = 判据本身的验收标准；
        //     注入形态必须与产品里真实存在的形态一致，且至少三种形态全红才算数。**
        //
        // ▶ 现在的修法：**不猜形态，直接对拍真源**（A 窗推荐方案一）。
        //   平台层若有 op 名单常量（`KNOWN_OPS`），就把它与引擎 `OP_CATALOG` **逐名比对**，
        //   不一致即红。硬判据、不依赖字符串启发式 ⇒ 数组怎么写都抓得住。
        //   正则兜底仍然保留（查"单字符串里塞名单"这种散写形态），两者是叠加关系不是替代。
        const knownOpsMatch = /export\s+const\s+KNOWN_OPS\s*=\s*\[([\s\S]*?)\]\s*;/.exec(raw);
        if (knownOpsMatch) {
            const listed = [...knownOpsMatch[1].matchAll(/['"`]([a-z]+)['"`]/g)].map((x) => x[1]);
            const truth = TRUTH_OPS;
            const mismatched = (truth.length === listed.length)
                && truth.every((o, i) => o === listed[i]);
            if (!mismatched || listed.includes('search')) {
                offenders.push(`${path.relative(argDir, f)}（KNOWN_OPS 与引擎 OP_CATALOG 不一致：`
                    + `实有 [${listed.join(',')}] vs 真源 [${truth.join(',')}]）`);
            }
        }
        // 正则兜底：单字符串里塞名单（散写形态）
        const lines = raw.split('\n');
        lines.forEach((l, i) => {
            const isComment = /^\s*(\*|\/\/|\/\*)/.test(l);
            if (isComment) return;
            const strs = [...l.matchAll(/'([^']*)'|`([^`]*)`|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? x[3]);
            for (const s of strs) {
                if (!/\bsearch\b/.test(s)) continue;
                const others = OPS.filter((o) => new RegExp(`\\b${o}\\b`).test(s)).length;
                if (others >= 3) offenders.push(`${path.relative(argDir, f)}:${i + 1}（字符串里的 op 名单含 search：${s.slice(0, 60)}…）`);
            }
        });
        // ★ 再补一条兜底：**数组里逐元素出现 'search'**（上一版完全漏掉的形态）。
        //   判据：源文件里出现 `'search'` / `"search"` 这种**独立字符串字面量**且不在注释里
        //   ⇒ 平台层的 op 名单/白名单里混进了已迁走的 op。
        //   （注释里提到 search 是允许的：那是"已迁 FP"的留档说明。）
        lines.forEach((l, i) => {
            const isComment = /^\s*(\*|\/\/|\/\*)/.test(l);
            if (isComment) return;
            // 同一行里若已由上面"长字符串"判据报过，避免重复
            if (/['"`][^'"`]*\bsearch\b[^'"`]*['"`]/.test(l) && /\bsearch\b/.test(l)) {
                const hasLong = [...l.matchAll(/'([^']*)'|`([^`]*)`|"([^"]*)"/g)]
                    .some((x) => { const s = x[1] ?? x[2] ?? x[3]; return /\bsearch\b/.test(s) && OPS.filter((o) => new RegExp(`\\b${o}\\b`).test(s)).length >= 3; });
                if (hasLong) return;
            }
            if (/['"`]search['"`]/.test(l)) {
                offenders.push(`${path.relative(argDir, f)}:${i + 1}（数组/字面量里逐元素出现 'search'：${l.trim().slice(0, 70)}）`);
            }
        });
    }
    if (offenders.length) fail(`这些文案面还在教 op:search：\n      ${offenders.join('\n      ')}`);
    else pass(`文档面零 op:search 教学（md ${docs.length} 份 + 平台 js ${platformJs.length} 份；"已迁 FP"类说明句按设计保留）`);
}

// ─────────── 白名单信息行（不判红）───────────
console.log('\n【白名单：双留件引用计数（只报数，不判红）】');
{
    const files = listCode(argDir);
    for (const k of DOUBLE_KEEP) {
        const base = path.basename(k);
        let count = 0;
        const where = [];
        for (const rel of files) {
            if (rel === k.replace(/\//g, path.sep) || rel === k) continue;   // 自己不数自己
            const src = stripComments(fs.readFileSync(path.join(argDir, rel), 'utf8'));
            const re = new RegExp(`['"][^'"]*${base.replace('.', '\\.')}['"]`, 'g');
            const n = (src.match(re) ?? []).length;
            if (n > 0) { count += n; where.push(rel); }
        }
        info(`${k}：CTX 侧被引用 ${count} 次${where.length ? '（' + where.join(', ') + '）' : ''}`
            + ` —— v2.2 §一-4 双留口径：FP 拿一份、CTX 留守不删，0 引用属设计内`);
    }
}

// ─────────── 汇总 ───────────
console.log('\n' + '─'.repeat(60));
const total = ok.length + failures.length;
console.log(`拆干净机检：${total} 项 / 失败 ${failures.length}`);
console.log(`CLEAN_SPLIT_SUMMARY total=${total} failed=${failures.length} status=${failures.length > 0 ? 'FAIL' : 'PASS'}`);
if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  · ${f}`);
    console.log('\n不通过 ❌ —— 拆接口不干净，别当"差不多"过');
    process.exit(1);
}
console.log('\n拆干净 ✅ —— CTX 侧对 FP 的件零引用残留（§三-23 判据全过）');
