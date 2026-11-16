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
 * verify/release-check.mjs — G9：可安装版自检（在成品目录里验，不在开发区验）
 *
 * 干什么：对 `releases/1.0.0/` 这个**成品**跑九项检查，全程不依赖开发区文件。
 * 为什么这样：开区跑绿 ≠ 装起来的包能跑（1.2.2 就踩过"包内产物"事故）。
 * 边界：只读成品、只在 Temp 建临时库，跑完即删。
 *
 * 跑法：node engine/verify/release-check.mjs（在开发区跑，脚本自己切到成品目录）
 */

import fs from 'node:fs';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 本文件有两个家：开发区 `engine/verify/` 与成品内 `engine/verify/`。
//   两者都是 `<包根>/engine/verify/`，所以"再上两级"恒为该树之根。
//   开发区里成品在 `<根>/releases/1.0.0`；成品里它自己就是成品 ——
//   所以必须判一下，否则在成品里会推成 `<成品>/releases/1.0.0`（路径翻倍，九项全红）。
const PKG_ROOT = path.dirname(path.dirname(HERE));
const WORK = PKG_ROOT;
const OUT = fs.existsSync(path.join(PKG_ROOT, 'releases', '1.0.0'))
    ? path.join(PKG_ROOT, 'releases', '1.0.0')
    : PKG_ROOT;
// ★ 临时目录须容错解析：默认走系统临时目录（可用 TEMP_DEV_DIR 固定），
//   但成品装机后可能落在不可写位置（如 <profile>/Temp）→ EPERM 假红。
//   规矩：优先工作区 Temp，不可用就退系统临时目录。
const RUN = makeTempRunDir('release-check');
let n = 0;
const results = [];
async function check(label, fn) {
    try { await fn(); n++; results.push({ label, ok: true }); console.log(`  ✓ ${label}`); }
    catch (e) { results.push({ label, ok: false, why: e.message }); console.log(`  ✗ ${label}\n      ${e.message}`); }
}

try {
    console.log(`验收成品：${OUT}\n`);
    fs.mkdirSync(RUN, { recursive: true });

    // ★ 2026-11-09 ④步 CTX 净身（§三-24②，维护方 14:0x「乙态摘净」）：目录清单 **六项 → 四项**。
    //   摘 `deps` / `fp`：op:search 与 index{url} 迁走后，CTX 对这两层零消费（论据链见
    //   assemble-release.mjs 的 CARRY_DIRS 注释）。三处必须同批：CARRY_DIRS / 本行 / pkg.files，
    //   少改一处 = 装配出带死重的包或门报缺件。
    await check('① 包结构四项齐（platform/ours/skills/engine；deps/fp 已随净身摘净；modes 已随模式退役）', () => {
        for (const d of ['platform', 'ours', 'skills', 'engine']) {
            if (!fs.existsSync(path.join(OUT, d))) throw new Error(`缺 ${d}/`);
        }
        if (fs.existsSync(path.join(OUT, 'bridges'))) throw new Error('bridges/ 是旧名（已改 platform/），不该还在');
        // 反向守门：净身摘掉的层不许复活（复活 = 有人在往 CTX 里塞 search 的底座）
        for (const d of ['deps', 'fp']) {
            if (fs.existsSync(path.join(OUT, d))) throw new Error(`${d}/ 不该再进 CTX 成品（§三-24 乙态摘净）`);
        }
    });

    await check('② 引擎目录完整（index.mjs + registry.mjs + libs/ + 17 块）', () => {
        for (const f of ['index.mjs', 'registry.mjs', 'package.json']) {
            if (!fs.existsSync(path.join(OUT, 'engine', f))) throw new Error(`缺 engine/${f}`);
        }
        const blocks = fs.readdirSync(path.join(OUT, 'engine', 'blocks'));
        if (blocks.length !== 17) throw new Error(`块数 ${blocks.length} ≠ 17：${blocks.join(',')}`);
        for (const b of blocks) {
            const dir = path.join(OUT, 'engine', 'blocks', b);
            for (const f of ['index.js', 'meta.js', 'selftest.mjs']) {
                if (!fs.existsSync(path.join(dir, f))) throw new Error(`${b} 缺 ${f}`);
            }
        }
    });

    await check('③ ref/ 没被装进来（基线副本不该进成品）', () => {
        if (fs.existsSync(path.join(OUT, 'engine', 'ref'))) throw new Error('engine/ref 被装进成品了');
    });

    await check('④ package.json version = 1.0.0 + files 含 engine + **不得含 deps/fp**', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
        if (pkg.version !== '1.0.0') throw new Error(`version=${pkg.version}`);
        if (!pkg.files.includes('engine')) throw new Error('files 白名单缺 engine');
        if (pkg.scripts) throw new Error('旧构建脚本没清掉（build-core/build-slices 已不适用）');
        // ★★ 2026-11-09 ④步 CTX 净身（本条由某次实测 复核抓出后补）：
        //   **反向断言** —— files 白名单里不许再出现 deps / fp。
        //   为什么必须单独立一条（这是"假绿"的现场）：
        //     本轮第一次施工只改了**根** package.json 的 files，但成品 package.json 是
        //     `assemble-release.mjs:312` 用**硬编码白名单覆盖**写的 ⇒ 成品仍列着两个目录。
        //     而 ① 门只查"目录在不在"、本条原来只查"含不含 engine"，**两道门都不看"不该含什么"**
        //     ⇒ 十道门全绿，缺陷静默通过。净身版 §三-12「漏一处 = 假绿」就是这个形状。
        //   危害链：成品向包管理器声明不存在的目录（文案不诚实）；将来有人重建 deps//fp/
        //     会被白名单自动打进包 = 净身过的死重复活。
        const banned = ['deps', 'fp'].filter((d) => pkg.files.includes(d));
        if (banned.length) {
            throw new Error(`files 白名单里仍有已摘净的层：${banned.join(', ')}`
                + `（§三-24 乙态摘净；改 assemble-release.mjs 的 pkg.files 硬编码清单，` 
                + `**不是**改根 package.json —— 成品那份是装配时覆盖写的）`);
        }
    });

    /**
     * ⑤ 平台匹配层一致性（G9 的门⑤）。
     *
     * ★ 口径沿革（2026-11-03，三次，每次都因事实变了）：
     *
     *   第一次，G9 原话「桥接层一行不改就能接上新引擎」。但工具面从 11 面折叠成 2 面，
     *   `catalog.js` / `modes/*.json` **必须**跟着换 → 改成"白名单允许不同但必须对拍一致"。
     *
     *   第二次，设计确定：「已经没有的东西桥上留着干嘛」：1.0.0 没有子进程引擎，
     *   `rpc.js` / `engineMode` / `serverPath` 整条链路必须删 → 改成"该删的都删了 + 无残留"。
     *
     *   第三次（本次），设计确定：「这层不是桥了，叫**平台匹配模块**，按平台不同对接我们的软件」：
     *   目录 `bridges/` → `platform/`，入口 `bridge.js` → `plugin.js`。
     *   所以本门也从"桥接层一致性"改名为"平台匹配层一致性"。
     *
     *   现在的判据是**可核查的三条**（比"完整节相同"有信息量得多）：
     *     A. 该消失的东西必须已消失（旧名 bridges/ / src/ / 52 legacy / rpc.js）
     *     B. 成品里不许再有 MCP 子进程时代的**活代码**
     *     C. 工具面数据面必须与引擎真目录对拍一致
     */
    await check('⑤ 平台匹配层已去 MCP 化（死代码删净 + 无残留概念 + 数据面对拍）', () => {
        // A. 该删的必须删掉（含旧目录名 bridges/）
        const OBSOLETE = [
            'bridges',
            'platform/rpc.js',
            'src',
            'ours/index-52-legacy.js',
            'ours/mcp-client-52-legacy.js',
            'ours/index-52-legacy.d.ts',
            'ours/mcp-client-52-legacy.d.ts',
            'ours/text-guard.js',
            'ours/text-guard.d.ts',
            // ★ 2026-11-04 文案面进 ctx.md 后描述渲染器是第二份实现（占位符已由引擎填），删整件。
            'ours/description.js',
            // ★ 2026-11-04 模式系统退役（原版转接整条删除）：modes/ 不许复活。
            'modes',
            // ★ 2026-11-04 P4 沙箱归一：桥侧 guard 删除 —— 受限执行只在引擎里做，
            //   桥再留一份执行路径 = by_tool 恒 0 的假围栏复活。
            'ours/sandbox-exec.js',
        ];
        for (const rel of OBSOLETE) {
            if (fs.existsSync(path.join(OUT, rel))) throw new Error(`1.0.0 不该有 ${rel}，但它还在`);
        }
        // ★ 文案面反过来也成立：ctx.md 必须**在**成品里（引擎 blocks 整目录递归拷，
        //   漏拷 = 14-tools import 当场抛 = 一个工具都注册不上）。
        const CTX_MD = path.join(OUT, 'engine', 'blocks', '14-tools', 'descriptions', 'ctx.md');
        if (!fs.existsSync(CTX_MD)) throw new Error('成品缺 engine/blocks/14-tools/descriptions/ctx.md（文案面真源）');
        const mdText = fs.readFileSync(CTX_MD, 'utf8');
        if (Buffer.byteLength(mdText, 'utf8') > 1563) throw new Error(`ctx.md ${Buffer.byteLength(mdText, 'utf8')} B > 1563 B（≈300 token）`);

        // B. 全包扫残留概念（**只看代码行**：注释里的历史说明是资产，不是残留）
        //    "已经没有的东西留着干嘛"指的是**活代码**；把历史记在注释里正好相反——
        //    它让下一个人知道为什么这些概念被删掉。
        const RESIDUE = /McpRpcClient|buildChildRuntime|resolveServerScript|defaultServerScript|server\.bundle|engineMode|serverPath|handshakeTimeoutMs/;
        const offenders = [];
        const isComment = (line) => /^\s*(?:[*/]|#)/.test(line) || line.includes(' * ');
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); continue; }
                if (!e.name.endsWith('.js') && !e.name.endsWith('.mjs')) continue;
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    if (isComment(line)) return;
                    if (RESIDUE.test(line)) offenders.push(`${path.relative(OUT, p)}:${i + 1}  ${line.trim()}`);
                });
            }
        };
        for (const d of ['platform', 'ours', 'skills']) {
            const p = path.join(OUT, d);
            if (fs.existsSync(p)) walk(p);
        }
        if (offenders.length > 0) {
            throw new Error('成品里还留着子进程时代的活代码：\n      ' + offenders.slice(0, 8).join('\n      '));
        }

        // C. 工具面数据面仍必须与引擎真目录对拍
        const cat = fs.readFileSync(path.join(OUT, 'platform', 'catalog.js'), 'utf8');
        if (!/'ctx'/.test(cat)) throw new Error(`catalog.js 缺工具位 'ctx'`);
        for (const old of ['ctx_run', 'ctx_recall', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_fetch_and_index', 'ctx_upgrade', 'ctx_insight']) {
            if (new RegExp(`'${old}'`).test(cat)) throw new Error(`catalog.js 还留着旧工具名 ${old}（1.0.0 只有 ctx；2026-11-04 不留兜底）`);
        }
        // ★ 2026-11-04 模式退役：平台层任何地方再出现 'vanilla'/'bubble' 字面量 = 僵尸接口
        for (const f of ['deployment.js', 'runtime.js', 'plugin.js', 'routing.js', 'tool-def.js', 'catalog.js', 'skill-set.js']) {
            const src = fs.readFileSync(path.join(OUT, 'platform', f), 'utf8');
            if (/['"](vanilla|bubble)['"]/.test(src))
                throw new Error(`platform/${f} 又出现了模式字面量`);
        }
    });

    await check('⑥ 成品里的引擎能独立跑 --selftest（不依赖开发区）', async () => {
        const entry = await import(pathToFileURL(path.join(OUT, 'engine', 'index.mjs')).href + `?t=${Date.now()}`);
        const engine = await entry.createEngine({ contentDir: path.join(RUN, 'g1'), level: 'error' });
        if (engine.blocks.length !== 17) throw new Error(`块 ${engine.blocks.length}/17`);
        if (engine.missingBlocks.length !== 0) throw new Error(`缺块：${engine.missingBlocks.join(',')}`);
        // ★ 2026-11-09 ④步 CTX 净身：14 → 13（op:search 整条迁 FP，见净身版 §三-3）。
        if (engine.opCatalog.length !== 13) throw new Error(`op ${engine.opCatalog.length}/13`);
        JSON.parse(JSON.stringify(engine.opCatalog));
        engine.dispose();
    });

    await check('⑦ 成品引擎真写真搜（在成品目录里）', async () => {
        const entry = await import(pathToFileURL(path.join(OUT, 'engine', 'index.mjs')).href + `?t=${Date.now()}`);
        const engine = await entry.createEngine({ contentDir: path.join(RUN, 'rs'), level: 'error' });
        const w = await engine.call('ctx', { op: 'index', content: '# 成品验证\n僵尸进程会持有 WAL 锁。', source: 'rel-doc' });
        if (w.isError) throw new Error(`写入失败：${w.content[0].text}`);
        const r = await engine.call('ctx', { op: 'recall', queries: ['僵尸进程'] });
        if (!r.content[0].text.includes('rel-doc') && !r.content[0].text.includes('僵尸')) throw new Error(`召回不到：${r.content[0].text.slice(0, 80)}`);
        engine.dispose();
    });

    await check('⑧ 成品里 17 块 selftest 全绿', async () => {
        const ORDER = ['01-core', '02-project', '03-storage', '04-store', '05-analyze', '06-gram', '07-tokenize',
            '08-writer', '09-reader', '10-recall', '11-memory', '12-lifecycle', '13-sandbox',
            '14-tools', '15-hooks', '16-entry', '17-plugs'];
        for (const b of ORDER) {
            const st = path.join(OUT, 'engine', 'blocks', b, 'selftest.mjs');
            process.exitCode = 0;
            try { await import(pathToFileURL(st).href + `?t=${Date.now()}`); }
            catch (e) {
                // 13-sandbox 在受限宿主下会以 SKIP 退出（exit 2，不是断言失败）
                if (b === '13-sandbox') continue;
                throw new Error(`${b}: ${e.name}: ${String(e.message).split('\n')[0]}`);
            }
            // ★ 13-sandbox 的真跑组需要不受限宿主（spawn 管道），受限下 exit 2 = SKIP，放行
            const code = process.exitCode ?? 0;
            if (b === '13-sandbox' && code === 2) { process.exitCode = 0; continue; }
            if (code !== 0) throw new Error(`${b} selftest 退出码 ${code}`);
        }
        process.exitCode = 0;
    });

    await check('⑨ ASSEMBLY.json 记了装配来源与件数', () => {
        const a = JSON.parse(fs.readFileSync(path.join(OUT, 'ASSEMBLY.json'), 'utf8'));
        if (a.version !== '1.0.0') throw new Error(`version=${a.version}`);
        if (!a.assembledAt) throw new Error('缺 assembledAt');
        if (!a.total || a.total.files < 100) throw new Error(`件数异常 ${a.total?.files}`);
    });

    // ★ ⑩ R11（2026-11-04 测试汇总）：**成品里每个相对 import 都必须能解析**。
    //   为什么必须单独立一条：R11 新增 `ours/python-find.js` 时，装配脚本的
    //   OVERLAY_OURS 白名单没收录它 → 成品里 fp-bridge.js 的 import 指向一个
    //   **不存在的文件**。这种缺陷 ①启动不报（只有走 url 抓取那一支才 import 到）
    //   ②G9 前九项全绿 ③真机上表现为"某个 op 莫名失败"。同族缺陷已经吃过一次
    //   （G11 的"调用了但没用"），这里改成**扫全成品**，把"缺件"变成开箱即红。
    await check('⑩ 成品里所有相对 import 都有对应文件（防漏装配）', () => {
        const ROOT = OUT;
        const exts = ['.js', '.mjs', '.json'];
        const missing = [];
        let scanned = 0;
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'ref') continue;
                    walk(p);
                    continue;
                }
                if (!/\.(js|mjs)$/.test(e.name)) continue;
                scanned++;
                const src = fs.readFileSync(p, 'utf8');
                // ★ 先剥掉注释：注释里的 `import '../ours/x.js'` 是**文档示意**，
                //   不是真 import（layout.js:11 就写着这么一句，第一版判据把它当漏件报了）。
                //   判据宁可窄一点：只认真代码里的相对路径。
                const code = src
                    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
                    .replace(/^[ \t]*\/\/.*$/gm, '');   // 整行行注释
                // 静态 import/export-from 与动态 import('...') 的字面量相对路径
                const re = /(?:^|[^\w$])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
                let m;
                while ((m = re.exec(code)) !== null) {
                    const spec = m[1] ?? m[2];
                    if (!spec) continue;
                    const base = path.resolve(path.dirname(p), spec.split('?')[0]);
                    // 三种合法落点：原样 / 补扩展名 / 目录 index
                    const hit = exts.some((ext) => fs.existsSync(base + ext))
                        || fs.existsSync(base)
                        || exts.some((ext) => fs.existsSync(path.join(base, `index${ext}`)));
                    if (!hit) missing.push(`${path.relative(ROOT, p)} → ${spec}`);
                }
            }
        };
        walk(ROOT);
        if (scanned === 0) throw new Error('一个 .js 都没扫到 —— 路径不对，判据是假绿');
        if (missing.length > 0) {
            throw new Error(`成品里有 ${missing.length} 个相对 import 指向不存在的文件（装配漏件）：\n      ${missing.slice(0, 8).join('\n      ')}`);
        }
    });

    // ★ ⑪ 2026-11-05 真机事故：**成品的 cordis.patch.yml 必须是宿主认得的形状**。
    //   事故经过：装配脚本的兜底模板写成了 `- id: dsh-context / config: / - id: ...`
    //   （少 `- insert:` 层），装进去之后 bundle patch 整行不生效 → dsh-eco-context
    //   压根不挂载 → 工具面全空；宿主里那条同 id 的配置行失去宿主，
    //   连带把同源部署一起打死。真机表现就是"ctx 没了"。
    //   前十二道门全绿也没用 —— **它们谁都没看这个文件**。所以补这道门：
    //   形状不对（无 insert / id 或 name 不在 insert 底下）直接红。
    await check('⑪ cordis.patch.yml 是 insert 形状（bundle patch 能被宿主装载）', () => {
        const p = path.join(OUT, 'cordis.patch.yml');
        if (!fs.existsSync(p)) throw new Error('成品缺 cordis.patch.yml —— 装进去就是个不挂载的壳');
        const yml = fs.readFileSync(p, 'utf8');
        const lines = yml.split(/\r?\n/);
        // ★ 判据不能只是"四空格 id 存在"：事故形状里 `- id: dsh-eco-context` 也是四空格
        //   （它缩在 `config:` 之下），缺的是外层 `- insert:`。所以先否掉顶格 id，
        //   再要求 id 行出现在 insert 之后。
        if (!/^- insert:\s*$/m.test(yml)) {
            throw new Error('缺顶层 "- insert:" 行 —— bundle patch 不会生效（历史事故形状）');
        }
        if (lines.some((l) => /^- id:/.test(l))) {
            throw new Error('出现顶格 "- id:" 行 —— patch 形状错，id 必须在 insert 之下');
        }
        const insertAt = lines.findIndex((l) => /^- insert:\s*$/.test(l));
        const rowAt = lines.findIndex((l) => /^\s{4}- id:\s*dsh-eco-context\s*$/.test(l));
        if (rowAt < 0) throw new Error('insert 底下没有 4 空格缩进的 "- id: dsh-eco-context"');
        if (rowAt < insertAt) throw new Error('"- id:" 出现在 insert 之前 —— 顺序错');
        if (!/^\s{6}name:\s*'?"?dsh-eco-context'?"?\s*$/m.test(yml)) {
            throw new Error("insert 底下没有 6 空格缩进的 \"name: 'dsh-eco-context'\"");
        }
        // inject 必须在（否则 tools/systemPrompt 可能还没挂好就去注册工具）
        if (!/inject:\s*\[[^\]]*\btools\b/.test(yml)) {
            throw new Error('缺 inject: [tools, ...] —— 注册工具时宿主服务可能还没就绪');
        }
    });

    // ─────────────────────────────────────────────────────────────
    // ★★ ⑫ R1「web-search 冻结导出面逐名门」——**整组退役**（2026-11-09 ④步 CTX 净身 §三-10）
    // ─────────────────────────────────────────────────────────────
    //   原文（已在 BACKUP\engine\verify\release-check.mjs 留底，14 名 + internals 4 键）：
    //     await check('⑫ R1 冻结导出面逐名比对（14 名 + internals 4 键 = S55 内嵌基准）', async () => {
    //         const FROZEN_NAMES = ['ENGINES', '__webSearchInternals', 'clip', 'doctor', 'media', 'page',
    //             'parseBing', 'parseBingRss', 'parseDdg', 'parseGithub', 'parseNpm', 'parseWikipedia',
    //             'search', 'stripTags'];
    //         const FROZEN_INTERNALS = ['ENGINES', 'clip', 'getHtml', 'render'];
    //         W = await import(<OUT>/ours/web-search.js);
    //         …逐名比对 missing/extra + internals 键…
    //     });
    //
    //   **为什么必须退役**：`ours/web-search.js` 已随 op:search 整条迁 FP（§三-13），
    //   CTX 成品里这件**不存在** ⇒ 本门第一步就 `ERR_MODULE_NOT_FOUND`
    //   （实测：`Cannot find module …\releases\1.0.0\ours\web-search.js`）。
    //   这不是判据红，是门在**查一个已经不存在的件**。
    //
    //   **三方自决的依据**（净身版 §14.2‴ 判别式，本窗按参考实现保持一致口径）：
    //     该段含"维护方"字样 = false（纯工程冻结面，S55 战役编号）；
    //     维护方 14.1-5「所有硬指标可提报修改」；07c/a77 均撤回上报。
    //   **采退役、不采改判** —— 改判 = 让门去查 CTX 已不存在的件（把 search 塞回来的变种）。
    //
    //   **覆盖转移账（不粉饰，FP ⑤ 步必还）**：
    //     CTX 侧"web-search 冻结导出面 14 名 + internals 4 键"的回归覆盖**归零随迁 FP**；
    //     FP 侧须**自建等价冻结面基准**（a77 K4 建议，与〔M5〕SSRF 覆盖转移账同型）。
    //     历史价值留档：本门是 N8 批次 1（票面 13 v0.1）产物，基准=某次实测 Q1 口径(a)
    //     内嵌字面清单（跨机可跑、零外部文件依赖，因为 06-基线-导出面.txt 在战役目录不可硬编码）；
    //     两型红当初特意分开报（某次实测 提醒）：import 炸（依赖缺失，⑩ 门管文件、本门管实际可载）
    //     ≠ 可载但名不符。**这条分工纪律不因拆插件失效** —— FP 重建时应原样继承。
    //   ★ 下游影响：G9 由 12 项 → **11 项**（"绿"= 收缩后全绿，不是带红过门，§四-1）。

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`G9 成品自检：${results.length} 项 / 失败 ${failed.length}`);
    if (failed.length > 0) {
        console.log('失败：' + failed.map((f) => f.label).join(' | '));
        process.exitCode = 1;
    }
    else {
        console.log('G9 全绿 ✅ —— 可安装版就绪');
    }
}
catch (e) {
    console.error('release-check 崩了：', e.message);
    process.exitCode = 1;
}
finally {
    releaseTempRunDir(RUN);
}
