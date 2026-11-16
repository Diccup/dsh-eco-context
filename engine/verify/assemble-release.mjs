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
 * verify/assemble-release.mjs — 装配可安装版 `releases/1.0.0/`
 *
 * 干什么：把「新引擎 + 平台匹配层 + 技能 + 依赖」装成一个完整的可安装包，
 *        形状 `platform/ + ours/ + skills/ + engine/ + deps/ + fp/`。
 *        ★ 2026-11-04：`modes/` 随模式系统退役不再装配（原版转接整条删除）。
 *        ★ 2026-11-05 设计确定：**1.2.2 已彻底退役，本包是完全独立的 1.0.0。**
 *          于是「壳」不再是外部目录 —— 壳就是**上一次装好的 releases/1.0.0 自己**，
 *          由 `CARRY_DIRS` 白名单就地承继（deps/fp/vendor/docs 这几层开发树里没有，
 *          只能从成品自身带过来）。引擎/平台/增强/技能四层仍然**每次从开发源重写**。
 * 为什么这样：维护方 20:2x 定「整个完整的工具安装包」；S9.8 的交付物就是这个目录。
 * 边界：**只装配、不改源**。装完必须跑 `verify/release-check.mjs` 验一遍。
 *
 * 红线：没有任何外部壳可依赖了（旧 `1.2.2engine` 与 `dsh-context-mode模块拆` 均已删）。
 *       本脚本只读两个地方：开发源（engine/ overlay/）+ 成品自身的 CARRY 层。
 *
 * 跑法：node engine/verify/assemble-release.mjs [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);
const WORK = path.dirname(ENGINE);                       // dsh-eco-context/（仓库文件夹 2026-11-04 按维护方决定已改名）
const OUT = path.join(WORK, 'releases', '1.0.0');

const force = process.argv.includes('--force');

/**
 * 从**上一版成品**承继的层（开发树里没有这些，删了就得重新造）。
 *
 * ★ 2026-11-05：原 `SHELL_DIRS` / `SHELL_FILES` 是"从 1.2.2engine 拷壳"，
 *   而那个目录（连同 `dsh-context-mode模块拆`）已经被维护方清掉了 ——
 *   脚本第一行 `if (!existsSync(SRC_PKG)) throw` 从此必抛，**装配链断了**。
 *   1.0.0 是独立版本，不该再向 1.2.2 要任何东西；这几层是**包内资产**
 *   （随包 python 库 / 网页抓取驱动 / vendor LICENSE / 文档），
 *   由成品自己持有、装配时原地保留即可。
 *
 * ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-24，维护方 14:0x 裁决「乙态摘净」）：
 *   `deps` 与 `fp` **从承继清单里摘除**。
 *   设计说明：「你CTX都不搜索留着给你生小的？」
 *   论据链（本轮实测，不是随手删）：
 *     · `fp/` 的唯一使用方曾是 `web-search.js → fp-bridge.js → fp/fpwebsearch.py`
 *       （见 engine-client.js 里 loadWebModule 的历史注记）；
 *     · `deps/pylibs`（curl_cffi 等）是 fp 腿的运行底座，同理只服务抓取；
 *     · op:search 与 index{url} 双双迁 FP 后，CTX 侧对这两层的引用 = **0**
 *       （壳/引擎/门/skill 全面扫描，见开发日志 L-0xx 的机检输出）。
 *   ⇒ 零消费方 = 死重，不留。连带同批三处（缺一处门就自炸）：
 *     ① 本行 CARRY_DIRS；② release-check ① 门目录清单六项→四项；③ package.json files 摘 deps/fp。
 *   ⚠️ 连带：`deps/pylibs_probe.py` 探针件随 `deps/` 整层走（它无 CTX 消费方）。
 *   ⚠️ FP 侧 `dsh-fp-search\src\deps` + `src\fp` 的预放**不受影响**（那是 FP 的件）。
 */
const CARRY_DIRS = ['vendor', 'docs'];
/**
 * 承继的**文件**（不是从开发源重写的那几个）。
 *
 * ★ 2026-11-05 修：`package.json` 与 `cordis.patch.yml` 原先**不在承继清单里**，
 *   而它们位于 OUT 根下 —— 重建时被 rmSync 一起删掉，于是脚本退回"最小模板"分支，
 *   成品的完整 manifest（依赖、exports、files 白名单、dsh.compatibility）**静默丢失**。
 *   这类丢失不会报错，只会让装出来的包少东西，所以必须显式承继。
 *   （README.md / LICENSING.md 不在此列：它们由 overlay 提供，每次重写。）
 */
const CARRY_FILES = ['LICENSE', 'package.json', 'cordis.patch.yml'];

let n = 0;
const step = (msg) => { n++; console.log(`  [${n}] ${msg}`); };

try {
    if (fs.existsSync(OUT) && !force) throw new Error(`目标已存在：${OUT}（要覆盖加 --force）`);

    console.log(`装配 → ${OUT}`);

    // ★ 2026-11-05：承继层先挪出去再重建 —— deps/fp/vendor/docs 是**包内资产**（随包 python 库、
    //   网页抓取驱动、vendor LICENSE、文档），开发树里没有副本，rmSync 一删就永久没了。
    //   做法：先搬到 temp 同级目录，重建 OUT，再搬回来。任何一步失败都不丢东西。
    const carrySrc = `${OUT}.__carry`;
    fs.rmSync(carrySrc, { recursive: true, force: true });
    if (fs.existsSync(OUT)) {
        fs.mkdirSync(carrySrc, { recursive: true });
        for (const d of CARRY_DIRS) {
            const from = path.join(OUT, d);
            if (fs.existsSync(from)) {
                fs.renameSync(from, path.join(carrySrc, d));
                step(`承继 ${d}/（挪出，重建后放回）`);
            }
        }
        for (const f of CARRY_FILES) {
            const from = path.join(OUT, f);
            if (fs.existsSync(from)) fs.renameSync(from, path.join(carrySrc, f));
        }
    }
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    if (fs.existsSync(carrySrc)) {
        for (const d of CARRY_DIRS) {
            const from = path.join(carrySrc, d);
            if (fs.existsSync(from)) {
                fs.renameSync(from, path.join(OUT, d));
                step(`放回 ${d}/`);
            }
        }
        for (const f of CARRY_FILES) {
            const from = path.join(carrySrc, f);
            if (fs.existsSync(from)) fs.renameSync(from, path.join(OUT, f));
        }
        fs.rmSync(carrySrc, { recursive: true, force: true });
    }

    // ①b ★ 平台匹配层 `platform/`：**全部由 overlay 提供**，壳里的 `bridges/` 一件不拷。
    //
    //   为什么整层都归 overlay：`bridges/` 这个命名本身已经过时了 ——
    //   它是"把外部 MCP 引擎接到 DSH 上的桥"。现在引擎是我们自己的（engine/ 17 块），
    //   这层要做的事变成「把我们的软件适配到不同平台」= **平台匹配模块**。
    //   既然职责变了、目录名也换了，就没有理由再从 1.2.2 的壳里继承任何一件。
    //
    //   顺带解决两个真机事故（2026-11-03）：
    //     · catalog.js 的 FULL_CATALOG 必须从 11 面 → 2 面；
    //     · modes/*.json 的 disabledTools 不能再列 1.0.0 里不存在的工具名；
    //     · 壳里的 bridges/modes/ 会让布局探测读错清单（已随整层不拷而消失）。
    const overlayDir = path.join(ENGINE, '..', 'overlay');
    if (!fs.existsSync(overlayDir)) throw new Error(`缺 overlay/ 目录：${overlayDir}（平台层全部来自这里，不能省）`);
    const copyOverlay = (rel) => {
        const from = path.join(overlayDir, rel);
        const to = path.join(OUT, rel);
        if (!fs.existsSync(from)) return false;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        return true;
    };
    // ★★ 2026-11-05 第二次同类事故（G9 ⑩ 现抓）：这里原来是**手写白名单**。
    //   加了 `job-host.js` 却忘了加进名单 → 成品里 platform/plugin.js 的
    //   `import './job-host.js'` 指向不存在的文件 → 装上去整个插件 import 失败。
    //   与 `cordis.patch.yml` 那次是**同一种病**：维护一份本来可以算出来的清单。
    //   现在改成**扫目录**：overlay/platform/ 里有什么就装什么，永远不可能漏。
    //   只排除非运行件（.md/.map/备份），其余一律进包。
    const platformDir = path.join(overlayDir, 'platform');
    if (!fs.existsSync(platformDir)) throw new Error(`缺 overlay/platform/：${platformDir}`);
    const PLATFORM_FILES = fs.readdirSync(platformDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((n) => /\.(js|mjs|json|yml)$/.test(n))
        .sort();
    if (PLATFORM_FILES.length === 0) throw new Error('overlay/platform/ 一个运行件都没有 —— 路径不对或目录被掏空');
    for (const f of PLATFORM_FILES) {
        if (!copyOverlay(`platform/${f}`)) throw new Error(`overlay/platform/${f} 拷贝失败（平台层必须完整）`);
        step(`装配 platform/${f}`);
    }
    for (const rel of ['modes/bubble.json', 'modes/vanilla.json', 'README.md', 'LICENSING.md']) {
        if (copyOverlay(rel)) step(`装配 ${rel}（1.0.0 数据面 / 文档面）`);
    }

    // ①b-2 ★ **自有增强积木里需要改的那几件，也归 overlay 管。**
    //
    //   2026-11-03 维护方提问「增强部分是否需要挪窝换地方」。跑完可达性 + 真机探针，
    //   答案是「要，但只挪**必须改的**那几件」——
    //
    //   `ours/` 整个目录仍从壳拷（52 件资产里绝大多数是完好的增强），
    //   但其中若干件是按 **52 的工具面**写的，1.0.0 折叠成 2 个工具后它们全错：
    //     · precompact.js     client.callTool('ctx_index')          → 同上，整段归档静默失败
    //     · output-containment.js 还耦合 text-guard.js（守卫已不存在的工具名）
    //   这些文件在**壳里**，而壳是红线目录（`releases/1.2.2engine` 全程不动）。
    //   所以它们的正确位置只能是 overlay —— 这是"挪窝"的全部理由：
    //   **不是"想换个地方放"，是"改不了又必须改"**。
    //   ★ 2026-11-04 P4 沙箱归一：sandbox-exec.js（桥侧 guard）整件删除 ——
    //   受限执行面进了引擎 13-sandbox，桥不再替引擎跑代码（清单同步移除 + OBSOLETE 反向守门）。
    // ★★ 2026-11-09 ④步 CTX 净身（净身版 §三-13；维护方裁：卡片随 search 全迁 FP）：
    //   平铺 13 → **5**。摘除的 8 件（全部只服务 op:search / index{url}）：
    //     web-search.js（search 本体）、fp-bridge.js、python-find.js（fp 腿的 python 发现件）、
    //     ws-transport.js / ws-engines.js / ws-text.js / ws-detect.js / ws-media.js（网络底座五件）。
    //   留下的 4 件（CTX 自己的增强层，与 search 无关）：
    //     cjk.js（中文分词适配）、output-containment.js（溢出保护 + **全工具输出入库**，plugin.js 挂着）、
    //     precompact.js（压缩归档）、session-memory.js（会话记忆）。
    //   ★★ 2026-11-14（项目 07）：`recall-hints.js`（道 A 推送）**已退役并删件**
    //   （说明：「把道A去掉，不要道A推送了」）。清单里留它 = 装配当场报"缺失"。
    //   ⚠️ 原注释里"fp-bridge 与 ws-transport 都 import python-find，漏装配就是
    //   ERR_MODULE_NOT_FOUND，要到 op:search 用 url 抓正文那一刻才炸"——那是当年的真实事故，
    //   现在这四件一起走，那条事故面整体搬到 FP 去了（FP 须重立同型门）。
    const OVERLAY_OURS = [
        'cjk.js', 'output-containment.js',
        'precompact.js', 'session-memory.js',
    ];
    for (const f of OVERLAY_OURS) {
        if (!copyOverlay(`ours/${f}`)) throw new Error(`overlay/ours/${f} 缺失（增强层必须完整）`);
        step(`装配 ours/${f}（overlay 覆盖壳）`);
    }

    // ①b-2 ★ N8 批次 1 · D1（2026-11-08，票面 11 v0.5）：**卡片目录整目录拷**。
    //   照本文件 platform 层先例（L124-133："维护一份本来可以算出来的清单"= 事故根源）
    //   与 engine 子目录的 cpSync 形状（下方 blocks/libs/docs/verify 循环）：
    //   engines/ 与 engines-offline/ 逐卡点名 = 又一份手写名单，加卡必漏装。
    //   existsSync 前置断言 = 某次实测 Q1 建议 a：目录缺失静默跳过同样是漏装事故。
    //
    // ★★ 2026-11-09 ④步 CTX 净身：**整段退役**（净身版 §三-13 与 §三-23 的口径冲突，
    //   经维护方 2026-11-09 裁决：24 卡随 search 全迁 FP）。
    //   实测判据（本轮全仓 import 扫描）：`engines/`(17 卡) 与 `engines-offline/`(7 卡)
    //   **只被** `web-search.js` 与 `ws-engines.js` 引用，无第三处消费方；
    //   而这两件本身也在上面的 OVERLAY_OURS 里被摘除 ⇒ 24 卡留在 CTX 必成**零消费方死重**。
    //   净身版 §三-13 只写"平铺 13→5"未点名卡片目录，但 §三-23 拆干净机检明确把
    //   `engines/`、`engines-offline/` 列为"必须零引用残留"目标 —— 两处对不上，故请裁。
    //   原文（已留底 BACKUP\engine\verify\assemble-release.mjs）：
    //     for (const d of ['engines', 'engines-offline']) {
    //         const from = path.join(overlayDir, 'ours', d);
    //         if (!fs.existsSync(from)) throw new Error(`overlay/ours/${d} 缺失（…）`);
    //         fs.cpSync(from, path.join(OUT, 'ours', d), { recursive: true });
    //         step(`装配 ours/${d}/（整目录递归拷，不点名单卡）`);
    //     }
    //   ⚠️ 连带：D1 门件数基准 **37 → 5**（平铺 5 件；卡片 24 张已不在 CTX），
    //   见本文件末尾 ④b D1 门断言处；两处必须同批改，否则门自炸（〔同批⑭〕）。

    // ①b-3 ★ **技能文档面**（2026-11-04 加）。
    //   SKILL.md 是给**模型**看的：壳拷过来的版本还在教 11 工具时代的名字
    //   （ctx_execute / ctx_index / ctx_search / ctx_batch_execute…），
    //   而 1.0.0 只有 `ctx` + op —— 模型照文档路由就调到不存在的工具上。
    //   skills/ 整层从 overlay 提供（同 platform/ 的规矩：该改的东西必须能改，
    //   壳是红线目录）。没提供的技能目录不装（ctx-insight/ctx-upgrade 已删，
    //   1.0.0 没有这两个能力，挂着是陷阱）。
    //   ★ 2026-11-05：技能名改成 `ctx` + `ctx-op-<op>` —— 能力本来就是
    //   `ctx({op:"…"})`，名字再挂旧工具名（ctx-doctor/ctx-index/…）是两套口径。
    // ★ 2026-11-09 ④步 CTX 净身（净身版 §三-6，〔同批③〕）：`ctx-op-search` 除名。
    //   机理：OP_CATALOG 摘了 search 行之后，G11 ⑧b 会判"目录名指向不存在的 op"必红
    //   （三方模拟：bad=[ctx-op-search]；同摘 bad=0）⇒ 必须与引擎清单同批摘。
    const OVERLAY_SKILLS = ['ctx', 'ctx-op-run', 'ctx-op-recall', 'ctx-op-index', 'ctx-op-stats', 'ctx-op-purge'];
    const skillsOut = path.join(OUT, 'skills');
    fs.rmSync(skillsOut, { recursive: true, force: true });
    for (const s of OVERLAY_SKILLS) {
        const from = path.join(overlayDir, 'skills', s, 'SKILL.md');
        if (!fs.existsSync(from)) throw new Error(`overlay/skills/${s}/SKILL.md 缺失（技能面必须与工具面一致）`);
        const to = path.join(skillsOut, s, 'SKILL.md');
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        step(`装配 skills/${s}/SKILL.md（1.0.0 工具面）`);
    }

    // ①c ★ 删掉 1.2.2 壳里**在 1.0.0 里已不存在**的东西
    //   （维护方 2026-11-03 定：「桥需要改就直接改桥，已经没有的东西桥上留着干嘛」）
    //
    //   平台层整层不拷壳之后，这里的 `bridges/` 相关项其实已无从产生；
    //   保留这些判断是**对承继层的反向守门**：万一哪天有人把旧壳目录加回来，
    //   这行会立刻把它删掉，而不是让它静默混进成品。
    //
    //   (c) `ours/index-52-legacy.js` + `ours/mcp-client-52-legacy.js` —— 52 原版整份遗留，
    //       全包无人 import（可达性扫描实测 0 引用），纯负担。
    //   (d) `src/` —— 1.2.2 的源码镜像（bridges/ + types/ 副本），全包无人 import。
    //   (e) `ours/text-guard.js` —— 守的是"vendored MCP server 推荐了未挂载工具"
    //       这一宿主行为。1.0.0 里 vendor/ 只剩 LICENSE、被守的 3 个工具名
    //       一个都不存在、4 条源字符串 grep 全无匹配 → **前提消失，纯空转**。
    //       它的 .d.ts 也一并删（`.js` 删了留 `.d.ts` 是孤儿）。
    //   (f) `ours/description.js` —— 2026-11-04 文案面进 `engine/blocks/14-tools/descriptions/ctx.md`
    //       后它只剩"填 {{webSearchUrl}}"一个功能，而引擎 attachBridgeContract 已经用
    //       webUrl 填了**同一条文案**（且覆盖面更大：工具描述 + op:list 自描述都填）。
    //       留两份实现 = 迟早漂移；按红线删整件，OVERLAY_OURS 同步移除。
    const OBSOLETE = [
        'bridges',
        'src',
        'ours/index-52-legacy.js',
        'ours/mcp-client-52-legacy.js',
        'ours/index-52-legacy.d.ts',
        'ours/mcp-client-52-legacy.d.ts',
        'ours/text-guard.js',
        'ours/text-guard.d.ts',
        'ours/description.js',
        // ★ P4 沙箱归一（2026-11-04）：guard 的受限执行已下沉进 13-sandbox ——
        //   它是壳拷资产，移出 OVERLAY_OURS 还不够，必须**主动删**（反向守门同 (f)）。
        'ours/sandbox-exec.js',
    ];
    for (const rel of OBSOLETE) {
        const target = path.join(OUT, rel);
        if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
            step(`删 ${rel}（1.0.0 已不存在）`);
        }
    }
    //    ★ **不拷 ref/**（那是 21 件行为基线副本，只给开发期对照，进成品会让包白胖 328 KB
    //      且暴露一条指向"原件"的线索 —— 基线不进成品是清单的定论）。
    fs.mkdirSync(path.join(OUT, 'engine'), { recursive: true });
    for (const f of ['index.mjs', 'registry.mjs', 'package.json']) {
        fs.copyFileSync(path.join(ENGINE, f), path.join(OUT, 'engine', f));
    }
    for (const d of ['blocks', 'libs', 'docs', 'verify']) {
        const from = path.join(ENGINE, d);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, 'engine', d), { recursive: true });
    }
    step('拷 engine/（index+registry+package+blocks+libs+docs+verify，**不含 ref/**）');

    // ③ package.json：版本 1.0.0（★ 2026-11-05：改为以**成品已有的 package.json** 为底，
    //    不再从外部壳读 —— 1.2.2 已退役，本包自带完整 manifest）
    const pkgPath = path.join(OUT, 'package.json');
    const pkg = fs.existsSync(pkgPath)
        ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        : { name: 'dsh-eco-context', version: '1.0.0', type: 'module', license: 'MIT' };
    pkg.version = '1.0.0';
    pkg.name = 'dsh-eco-context';
    pkg.description = 'dsh-eco-context 1.0.0（17 块积木引擎）';
    pkg.main = 'platform/plugin.js';
    pkg.exports = {
        '.': { import: './platform/plugin.js' },
        './package.json': './package.json',
        './cordis.patch.yml': './cordis.patch.yml',
    };
    // ★★ 2026-11-06 修：`files` 白名单漏了两件 → 装机槽（pnpm file: 装的槽 B）就少两件。
    //   机制：`pnpm add file:` 走 packlist（等价 npm 的 `files` 语义），
    //   **白名单外的文件根本不装**。槽 A（robocopy 目标）两件都在，槽 B 没有。
    //   实测坐实：造最小包（`files:['index.js','sub/keep.txt']`，源目录另有 `sub/drop.json`
    //   与 `ASSEMBLY.json`）→ `pnpm add file:../pkg` 后安装树里没有那两件。
    //   - `vendor/context-mode/package.json`：第三方项目 context-mode 1.0.169 的许可元数据
    //     （Elastic-2.0，声明 license/exports/bin）。2026-11-05 槽 B 缺件事故记的就是它。
    //   - `ASSEMBLY.json`：装配清单（谁、什么时候、从哪来、多少件）。release-check ⑨ 要读它。
    //   ★ 白名单必须与**槽 A 的实际内容逐件对拍** —— 漏一件 = 装机槽永远缺一件。
    // ★★ 2026-11-09 ④步 CTX 净身（§三-24③，某次实测 复核抓出的漏改）：
    //   **从 `'deps', 'fp'` 两项摘除**。
    //   ⚠️ 这条是本轮施工中真漏过的一处，血泪写在这里防再犯：
    //     实现方第一版只改了**根** `package.json` 的 files 段，但本行是**硬编码白名单**、
    //     装配时用它**覆盖**成品 package.json（上一行 `const pkg = ... 成品已有的 package.json`），
    //     所以根那份改了等于没改 —— 成品 files 仍列着两个已不存在的目录。
    //     十道门全绿也没抓住：release-check ① 只查"目录在不在"，**没有"files 里不许含 deps/fp"的反向断言**。
    //     ⇒ 这正是净身版 §三-12「漏一处 = 假绿」那个病的现场版；本轮已补反向断言（见 release-check）。
    //   危害链（若不修）：成品向包管理器声明不存在的目录（文案不诚实）；将来有人重建 deps//fp/
    //     会被 files 白名单自动打进包 = 净身过的死重复活。
    pkg.files = ['platform', 'ours', 'skills', 'engine', 'cordis.patch.yml', 'README.md', 'LICENSE', 'LICENSING.md', 'docs', 'vendor/context-mode/LICENSE', 'vendor/context-mode/package.json', 'ASSEMBLY.json'];
    // ★★ 2026-11-09 补（维护方决定摘 turndown 时发现的真盲区）：`dependencies` 原先**只继承旧成品**，
    //   根 package.json 改了等于没改 —— 与上面 :315 那次 deps/fp 事故**同型**（硬编码继承面盖掉源头改动）。
    //   修法：dependencies 以**根件为真源**覆盖进成品；摘净身死依赖（turndown/turndown-plugin-gfm）
    //   只改根件这一处即可生效。根件读不到时保持原行为（继承旧成品），不新增失败模式。
    const rootPkgPath = path.join(WORK, 'package.json');
    if (fs.existsSync(rootPkgPath)) {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
        if (rootPkg.dependencies) pkg.dependencies = rootPkg.dependencies;
    }
    delete pkg.scripts;                       // 旧包的构建脚本（build-core/build-slices）已不适用
    fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    step('写 package.json（version=1.0.0，main=platform/plugin.js）');

    // ③b ★ cordis.patch.yml：成品自带（不再从壳改）。只做原地 id/name 归一，幂等。
    //
    // ★★ 2026-11-05 事故（真机：两个 ctx 插件一起消失）：这里的**兜底模板写的是错形状**。
    //    兜底写的是
    //        - id: dsh-context          ← 缩进到某个已存在行的 config 里
    //          config:
    //            - id: dsh-eco-context
    //    而 bundle patch 的正确形状是**一行 insert**（对照 dsh-team / dsh-our-free-model）：
    //        - insert:
    //            - id: dsh-eco-context
    //              name: 'dsh-eco-context'
    //              inject: [tools, systemPrompt]
    //    错形状的后果不是"少点功能"，是**装载期整行不生效** → dsh-eco-context 不挂载 →
    //    工具面全空，而且 `dsh-deployment` 那条已存在的 `- id: dsh-eco-context` 配置行
    //    找不宿主，连带把同源部署一起打死（真机上表现就是"ctx 没了"）。
    //    根因链：CARRY_FILES 曾漏掉本文件 → 被 rmSync 删 → 走兜底 → 写成错形状 →
    //    **装出来的包每次都是坏的，且没有任何门禁看一眼它**。
    //    本处修法与门禁：兜底改成正确形状；写完**当场校验**，形状不对就抛（装配失败好过装出坏包）。
    const patchPath = path.join(OUT, 'cordis.patch.yml');
    if (!fs.existsSync(patchPath)) {
        fs.writeFileSync(patchPath, [
            '# dsh-eco-context bundle patch.',
            '# 一行 insert 即挂载本包（宿主半身 = platform/plugin.js）。',
            '# inject 保证 tools / systemPrompt 两个服务先挂好，再去注册 ctx 工具。',
            '- insert:',
            '    - id: dsh-eco-context',
            "      name: 'dsh-eco-context'",
            '      inject: [tools, systemPrompt]',
            '      config:',
            '        enabled: true',
            '',
        ].join('\n'));
        step('写 cordis.patch.yml（成品缺 → 补 insert 形状模板）');
    }
    else {
        const yml = fs.readFileSync(patchPath, 'utf8');
        const fixed = yml
            .replace(/^(\s*)- id:\s*dsh-context-mode\s*$/gm, '$1- id: dsh-eco-context')
            .replace(/^(\s*)-? ?name: '?dsh-context-mode'? *$/gm, "$1name: 'dsh-eco-context'")
            .replace(/^# dsh-context-mode /, '# dsh-eco-context ');
        if (fixed !== yml) fs.writeFileSync(patchPath, fixed);
        step('cordis.patch.yml id/name 归一 → dsh-eco-context');
    }
    // ③c ★ 形状硬校验：没有 insert 行、或者 insert 底下不是 dsh-eco-context，一律装配失败。
    //     这道门是为了让"装出坏包"不可能悄悄发生 —— 事故里没人看这个文件。
    //     注意判据必须比"四空格 id 存在"更强：事故形状里 `- id: dsh-eco-context`
    //     也是四空格（它在 `config:` 之下），只是**没有被 `- insert:` 包住**。
    //     所以真正的判据是「没有顶格 `- id:`」＋「insert 之后才有 id 行」。
    {
        const yml = fs.readFileSync(patchPath, 'utf8');
        const lines = yml.split(/\r?\n/);
        const bad = [];
        const insertAt = lines.findIndex((l) => /^- insert:\s*$/.test(l));
        if (insertAt < 0) bad.push('缺顶层 "- insert:"（bundle patch 不会生效）');
        if (lines.some((l) => /^- id:/.test(l))) bad.push('有顶格 "- id:" 行（patch 形状错：id 必须在 insert 之下）');
        const rowAt = lines.findIndex((l) => /^\s{4}- id:\s*dsh-eco-context\s*$/.test(l));
        if (rowAt < 0) bad.push('insert 下缺 4 空格缩进的 "- id: dsh-eco-context"');
        else if (insertAt >= 0 && rowAt < insertAt) bad.push('"- id:" 出现在 insert 之前（顺序错）');
        if (!/^\s{6}name:\s*'?"?dsh-eco-context'?"?\s*$/m.test(yml)) bad.push("缺 6 空格缩进的 \"name: 'dsh-eco-context'\"");
        if (bad.length > 0) throw new Error(`cordis.patch.yml 形状不对：${bad.join('；')}\n${patchPath}`);
        step('cordis.patch.yml 形状校验通过（insert 行 + id/name 在 insert 之下）');
    }

    // ④ ASSEMBLY.json：装配清单（谁、什么时候、从哪来、多少件）
    const stat = (dir) => {
        let files = 0; let bytes = 0;
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else { files++; bytes += fs.statSync(p).size; }
            }
        };
        walk(dir);
        return { files, bytes };
    };
    const counts = {};
    for (const d of fs.readdirSync(OUT)) {
        const p = path.join(OUT, d);
        if (fs.statSync(p).isDirectory()) counts[d] = stat(p);
    }
    const total = Object.values(counts).reduce((a, c) => ({ files: a.files + c.files, bytes: a.bytes + c.bytes }), { files: 0, bytes: 0 });
    fs.writeFileSync(path.join(OUT, 'ASSEMBLY.json'), JSON.stringify({
        name: pkg.name,
        version: '1.0.0',
        assembledAt: new Date().toISOString(),
        assembledFrom: { engine: 'Work/dsh-eco-context/engine', platform: 'Work/dsh-eco-context/overlay/platform', ours: 'Work/dsh-eco-context/overlay/ours', carried: CARRY_DIRS.join(',') },
        counts,
        total,
        notes: [
            'engine/ 不含 ref/（基线副本，不进成品）',
            '1.0.0 完全独立：不再向 1.2.2 借壳，vendor/docs 由成品自身承继（deps/fp 已于 2026-11-09 净身摘净）',
            '工具面：只有 1 位 ctx（13 op 壳；2026-11-05 新增 op=switch 工具开关；2026-11-09 op=search 迁 FP）',
        ],
    }, null, 2) + '\n');
    step(`写 ASSEMBLY.json（总 ${total.files} 件 / ${(total.bytes / 1024 / 1024).toFixed(2)} MB）`);

    // ④b ★ N8 批次 1 · D1 门断言（票面 11 v0.5/v0.6；某次实测 Q1-b"装配末尾统一断言"）：
    //   两处 ours 全目录（开发仓 overlay/ours ↔ 产物 releases/1.0.0/ours）
    //   **递归件数一致 + 名单相同 + 逐件 SHA256 全等**，差值必须归零。
    //   现基线 = **5 件**（★ 2026-11-09 净身：原 37 件 = 13 平铺 + engines/17 + engines-offline/7，
    //   本轮平铺 13→5 且两个卡片目录整目录退役 ⇒ 37 → 5，见上方 ①b-2 注释与 OVERLAY_OURS）。
    //   件数只随卡片增减排除；此门同时是 D4 修法 A
    //   "成品侧守门 == 等价覆盖开发区侧"的前提（某次实测 钉的执行顺序：本门先于三门）。
    //   ⚠️〔同批⑭〕本基准与 OVERLAY_OURS 清单 / 卡片目录循环必须同批改，拆开做本门必自炸。
    {
        const srcDir = path.join(overlayDir, 'ours');
        const outDir = path.join(OUT, 'ours');
        const list = (d) => {
            const acc = [];
            const walk = (x, rel) => {
                for (const e of fs.readdirSync(x, { withFileTypes: true })) {
                    const p = path.join(x, e.name);
                    if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
                    else acc.push(`${rel}${e.name}`);
                }
            };
            walk(d, '');
            return acc.sort();
        };
        const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        const a = list(srcDir); const b = list(outDir);
        const onlySrc = a.filter((f) => !b.includes(f));
        const onlyOut = b.filter((f) => !a.includes(f));
        const diffHash = a.filter((f) => !onlySrc.includes(f)).filter((f) => sha(path.join(srcDir, f)) !== sha(path.join(outDir, f)));
        if (onlySrc.length || onlyOut.length || diffHash.length)
            throw new Error(`D1 门断言失败：overlay/ours=${a.length} 件 vs 产物 ours=${b.length} 件`
                + `｜源独有 ${onlySrc.join(',') || '-'}｜产物独有 ${onlyOut.join(',') || '-'}`
                + `｜哈希不一致 ${diffHash.join(',') || '-'}（差值必须归零 = B1 双写口径）`);
        step(`D1 门断言：两处 ours 逐件哈希全等（${a.length} 件，差值 0）`);
    }

    // ⑤ 装配后立刻自检：engine 能在成品目录里独立跑
    console.log('\n装配完成。下一步跑：node engine/verify/release-check.mjs');
    console.log(`位置：${OUT}`);
}
catch (e) {
    console.error('装配失败：', e.message);
    process.exitCode = 1;
}
