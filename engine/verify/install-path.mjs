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
 * verify/install-path.mjs — G10：**真机安装链路**门（不注入任何接缝）
 *
 * 为什么必须单独有这一道
 * ─────────────────────────────────────────────────────────
 * 2026-11-03 真机事故：五道门全绿，装上去却一个工具都没注册。根因有两处，
 * 而这两处**每一道门都绕过去了**：
 *
 *   · 所有门都用 `createEngine({...})` 直接 import 引擎 → 从没调过 `resolveEngineRoot()`
 *   · 所有门都直接 `seams.engineRoot = <硬写路径>` → 从没走过布局探测
 *
 * 结果：`resolveEngineRoot` 里那句 `existsSync('.build/server.js')`（1.2.2 的判据）
 * 在 1.0.0 的包上必抛，门却一次都没触发。
 *
 * **教训：被测函数只要在门里从没被真调用过，它就是零覆盖的，哪怕周围几十项断言全绿。**
 *
 * 这一道门做的事：完全模拟宿主加载插件的顺序，**一个接缝都不注入**。
 *
 *   ① 按 package.json 的 `main` 字段定位入口（而不是写死路径）
 *      —— 这同时验证了 package.json 里的入口声明是对的
 *   ② 用真实的 `resolveEngineRoot()`（不传 seams.engineRoot）
 *   ③ 用真实的 `layout()` 定位 skills/engine（modes 已随模式退役删除）
 *   ④ 用 mesh 的最小 ctx 走完 apply，断言 **恰好注册出 1 个工具（ctx）**
 *   ⑤ 拿注册出来的工具定义，真的调一次（真写真搜）
 *
 * 跑法：node engine/verify/install-path.mjs
 * 边界：只读成品，临时库落系统临时目录，跑完自删。
 */

import fs from 'node:fs';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 同 release-check：本文件在开发区和成品里都是 `<包根>/engine/verify/`，
//   包根恒为"再上两级"。开发区里成品在 `<根>/releases/1.0.0`；
//   成品里它自己就是成品 —— 必须判一次，否则路径翻倍、整门假红。
const PKG_ROOT = path.dirname(path.dirname(HERE));
const OUT = fs.existsSync(path.join(PKG_ROOT, 'releases', '1.0.0'))
    ? path.join(PKG_ROOT, 'releases', '1.0.0')
    : PKG_ROOT;
// ★ 临时目录须容错解析：默认走系统临时目录（可用 TEMP_DEV_DIR 固定），
//   但成品装机后可能落在不可写位置（如 <profile>/Temp）→ EPERM 假红。
//   规矩：优先工作区 Temp，不可用就退系统临时目录。
const RUN = makeTempRunDir('install-path');
/** 跑过 apply 的宿主（退出前要排掉它们的 disposer，否则 DB 句柄不释放） */
const appliedHosts = [];
/** DSH systemPrompt 的 section 序号兜底值（桩用；真值由宿主给）。 */
const SECTION_ORDER_FALLBACK_GUESS = 10;

/**
 * 造一个**最小但形状正确**的 Cordis ctx —— 全门只有这一份，避免两套桩各自漂移。
 *
 * 每个方法都照 DSH 的真实形状给，因为 `apply()` 会真的用到它们：
 *   get('tools')        → register(def) + get(name, scope)
 *   get('skills')       → register(entry)
 *   get('systemPrompt') → section / context / getSectionOrder / getContextOrder
 *   get('sandbox'|'sandboxPolicy') → 故意返回 undefined（验"装饰层缺失不影响工具注册"）
 *   effect(fn)          → 记下 fn 返回的 disposer
 *   on(name, fn)        → 挂事件
 */
function makeHost() {
    const noop = () => () => {};
    const registered = [];
    const disposers = [];
    const promptSections = [];
    const logs = [];
    const ctx = {
        logger: {
            debug: (m) => logs.push(m), info: (m) => logs.push(m),
            warn: (m) => logs.push(m), error: (m) => logs.push(m),
        },
        on: noop,
        effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return noop(); },
        get: (svc, dflt) => {
            if (svc === 'tools') {
                return {
                    register: (def) => { registered.push(def); return noop(); },
                    get: () => ({ name: 'ctx' }),
                };
            }
            if (svc === 'skills') return { register: noop };
            if (svc === 'systemPrompt') {
                return {
                    section: (def) => { promptSections.push(def); return noop(); },
                    context: (def) => { promptSections.push(def); return noop(); },
                    getSectionOrder: () => SECTION_ORDER_FALLBACK_GUESS,
                    getContextOrder: () => SECTION_ORDER_FALLBACK_GUESS,
                };
            }
            return dflt;                 // sandbox / sandboxPolicy：当作本宿主没有
        },
    };
    return { ctx, registered, disposers, promptSections, logs };
}

/**
 * 成品目录里没有 node_modules（依赖由宿主 profile 提供）。
 * 但本门要**真跑 apply()**，`plugin.js` 又会 `import z from '@deepseek-ai/schemastery'`。
 * 所以在一份临时副本里建一条指向真实依赖的链 —— 这不是"放宽判据"，而是
 * **模拟宿主真实的解析环境**（装到 DSH 里时，这些依赖正是从 profile 的 node_modules 来的）。
 *
 * 依赖只拷贝两份（schemastery + cosmokit，共 ~120 KB），跑完随 RUN 一起删。
 */
// ★ 发布版可移植化（2026-11-16）：原写死 `C:\Users\Diccup\.dsh\profiles\desktop\...`。
//   现在按当前用户家目录推，并按 profiles\ 下实际存在的目录名找（profile 名不一定叫 desktop）。
function findProfileNodeModules() {
    const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles');
    const cands = [];
    try {
        for (const e of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const nm = path.join(profilesRoot, e.name, 'node_modules', '@deepseek-ai');
            if (fs.existsSync(nm)) cands.push(nm);
        }
    } catch { /* profiles 目录不存在 → 下面退回 */ }
    if (cands.length > 0) return cands[0];
    return path.join(profilesRoot, 'desktop', 'node_modules', '@deepseek-ai');
}
const DEP_SRC = findProfileNodeModules();
const DEP_NAMES = ['schemastery', 'cosmokit'];

/** 把成品拷进 RUN，并接上依赖；返回入口路径。 */
function stageWithDeps() {
    const staged = path.join(RUN, 'pkg');
    fs.cpSync(OUT, staged, { recursive: true });
    const depDst = path.join(staged, 'node_modules', '@deepseek-ai');
    fs.mkdirSync(depDst, { recursive: true });
    for (const n of DEP_NAMES) {
        const from = path.join(DEP_SRC, n);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(depDst, n), { recursive: true });
    }
    return staged;
}

let n = 0, failed = 0;
const check = async (label, fn) => {
    try { await fn(); n++; console.log(`  ✓ ${label}`); }
    catch (e) {
        failed++;
        const stack = (e.stack ?? '').split('\n').slice(1, 6).filter((l) => l.includes('install-path') || l.includes('platform') || l.includes('ours'));
        console.log(`  ✗ ${label}\n      ${e.message}`);
        for (const line of stack) console.log(`      ${line.trim()}`);
    }
};

try {
    console.log(`真机安装链路验收：${OUT}\n`);
    if (!fs.existsSync(OUT)) throw new Error(`成品不存在：${OUT}（先跑 assemble-release.mjs）`);
    fs.mkdirSync(RUN, { recursive: true });

    // ① 按 package.json 的 main 定位入口 —— 顺带验证声明是对的
    const STAGED = stageWithDeps();
    let entryPath;
    await check('① package.json 的 main 指向真实存在的入口', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
        if (!pkg.main) throw new Error('package.json 缺 main');
        // 断言在**成品**上做（STAIGHT 那份只是加了 node_modules 的执行副本）
        const fromPkg = path.join(OUT, pkg.main);
        if (!fs.existsSync(fromPkg)) throw new Error(`main=${pkg.main} 指向的文件不存在`);
        entryPath = path.join(STAGED, pkg.main);
        if (!fs.existsSync(entryPath)) throw new Error(`暂存副本里也找不到入口 ${pkg.main}`);
        const exp = pkg.exports['.']?.import;
        if (exp !== './' + pkg.main.replace(/\\/g, '/')) throw new Error(`exports 与 main 不一致：${exp}`);
    });

    const plugin = await import(pathToFileURL(entryPath).href);

    await check('② 入口导出 Cordis 插件三件（name / Config / apply）', () => {
        if (typeof plugin.name !== 'string' || plugin.name.length === 0) throw new Error('缺 name');
        if (typeof plugin.Config !== 'function') throw new Error('缺 Config');
        if (typeof plugin.apply !== 'function') throw new Error('缺 apply');
    });

    await check('③ 真实 resolveEngineRoot()（不注入 seams）能定位引擎', async () => {
        const { PLATFORM_DIR } = await import(pathToFileURL(path.join(STAGED, 'platform', 'layout.js')).href);
        const { resolveEngineRoot } = await import(pathToFileURL(path.join(STAGED, 'platform', 'engine-client.js')).href);
        const root = resolveEngineRoot(PLATFORM_DIR);      // ★ 真解析，这是事故里从没被执行的那一行
        if (!root.endsWith('engine')) throw new Error(`解析结果不像 engine/：${root}`);
        if (!fs.existsSync(path.join(root, 'registry.mjs'))) throw new Error('解析出的 engine/ 缺 registry.mjs');
        if (!fs.existsSync(path.join(root, 'blocks'))) throw new Error('解析出的 engine/ 缺 blocks/');
    });

    await check('④ 真实 layout() 只认 skills/engine（modes 随模式退役删除）', async () => {
        const { layout } = await import(pathToFileURL(path.join(STAGED, 'platform', 'layout.js')).href);
        const l = layout();
        if ('modesDir' in l) throw new Error('layout 还导出 modesDir（模式已退役）');
        if (fs.existsSync(path.join(STAGED, 'modes'))) throw new Error('发布包里还有 modes/ 目录');
        if (!l.skillsDir.endsWith('skills')) throw new Error(`skillsDir 不像 skills/：${l.skillsDir}`);
    });

    let HOST;
    await check('⑤ 走完 apply() 恰好注册出 1 个工具（ctx；2026-11-04 折叠改名后）', async () => {
        HOST = makeHost();
        const { ctx, registered, logs } = HOST;
        await plugin.apply(ctx, { enabled: true, storageDir: path.join(RUN, 'lib') }, {});
        appliedHosts.push(HOST);
        const names = registered.map((d) => d.name).sort();
        if (names.length !== 1) throw new Error(`注册 ${names.length} 个工具（应 1）：${names.join(',') || '(无)'}\n      logs: ${logs.join(' | ')}`);
        if (names[0] !== 'ctx') throw new Error(`工具名不对：${names.join(',')}`);
        for (const d of registered) {
            if (typeof d.execute !== 'function') throw new Error(`${d.name} 缺 execute`);
            if (d.parameters === undefined || d.parameters.type !== 'object') throw new Error(`${d.name} 的 parameters 不是对象 schema`);
            if (!structuredClone(d.parameters)) throw new Error(`${d.name} 的 parameters 不可克隆`);
            if (d.description === undefined || d.description.length === 0) throw new Error(`${d.name} 缺描述`);
        }
        // 描述体积红线：折叠后模型只看得到这 1 个壳，不许超 1563 B（≈300 token，2026-11-05 抬）
        // ★ R-v6（2026-11-04 全功能核验⑤）：这条判据原来量**渲染后的描述**，而描述里
        //   曾嵌 `{{webSearchUrl}}` 的**真值**（安装绝对路径）—— 于是体积随安装位置漂移：
        //   装到 `...\ctx-mode-install-path-xxxx-pid\pkg\ours\web-search.js` 这种深路径，
        //   光这一行就多出二十几 B，门在临时目录里跑必红（活槽那条短路径反而不红）。
        //   **门红在"装到哪"上，而不是红在"文案超没超"，这判据本身是错的。**
        //   改法：① 描述里不许再出现安装绝对路径（模板必须自洽）；
        //        ② 体积按**模板固定值**量，不随环境漂移。
        // ★ 2026-11-09 净身注记（§三-11）：`{{webSearchUrl}}` 占位符已随 search 行摘除（§三-7），
        //   填充函数与 webUrl 参数也已退役（§三-8/§三-15）⇒ 上面那段"体积随安装位置漂移"的
        //   风险面**在本插件已整体消失**（FP 侧须重立同型判据：它的描述里仍会有自己的路径）。
        //   **教训不因拆插件失效**：本条仍照原样保留在此，作为"门红在装到哪、而不是文案超没超"
        //   这条判断题的出处；判据本身（按模板固定值量）对 ctx.md 继续有效，不需要改。
        const ctxTool = registered.find((d) => d.name === 'ctx');
        const descBytes = Buffer.byteLength(ctxTool.description, 'utf8');
        if (descBytes > 1563) {
            throw new Error(`ctx 描述 ${descBytes} B > 1563 B（≈300 token）`);
        }
        // ① 体积不许随安装位置漂移：再量一份"把安装根换成别的长路径"的描述，字节数必须不变。
        //   做法：描述里只要不含本包 STAGED 的绝对路径，就不可能有环境依赖。
        const stagedNorm = STAGED.replace(/\\/g, '/');
        if (ctxTool.description.includes(stagedNorm) || ctxTool.description.includes(stagedNorm.replace('file://', ''))) {
            throw new Error(`ctx 描述里嵌了安装绝对路径（${stagedNorm}）—— 描述体积会随安装位置漂移`);
        }
        // ② 描述里不许残留未填的占位符（漏给模型 = 教它用一个不存在的路径）
        if (/\{\{[^}]+\}\}/.test(ctxTool.description)) {
            throw new Error(`ctx 描述里还有没填的占位符：${(ctxTool.description.match(/\{\{[^}]+\}\}/g) ?? []).join(',')}`);
        }
    });

    await check('⑥ 注册出来的工具真能被调用（op:index → op:recall 搜回）', async () => {
        const registered = HOST?.registered ?? [];
        const run = registered.find((d) => d.name === 'ctx');
        if (!run) throw new Error('前一项没拿到工具定义');
        const exec = { signal: undefined };
        const w = await run.execute({ op: 'index', content: '# 安装链路验收\n僵尸进程会持有 WAL 锁。', source: 'install-path-doc' }, exec);
        if (w === undefined || typeof w.text !== 'string') throw new Error('index 没返回 {text}');
        if (w.text.includes('ERROR') || w.text.includes('失败')) throw new Error(`写入报错：${w.text.slice(0, 120)}`);
        const r = await run.execute({ op: 'recall', queries: ['僵尸进程'] }, exec);
        const text = r === undefined ? '' : String(r.text ?? '');
        if (!text.includes('install-path-doc') && !text.includes('僵尸')) {
            throw new Error(`召回不到（前 120 字）：${text.slice(0, 120)}`);
        }
    });

    await check('⑦ 卸载路径：apply 登记的 disposer 都能调用且不抛', async () => {
        // ★ 复用与 ⑤ 完全同一套桩 —— 两套桩会各自漂移，这正是本门存在的教训
        const host = makeHost();
        await plugin.apply(host.ctx, { enabled: true, storageDir: path.join(RUN, 'lib2') }, {});
        appliedHosts.push(host);
        if (host.registered.length !== 1) throw new Error(`第二次 apply 注册 ${host.registered.length} 个（应 1）`);
        if (host.disposers.length === 0) throw new Error('ctx.effect 没登记卸载函数');
        for (const d of host.disposers) if (typeof d === 'function') d();
    });

    /**
     * ⑧ 装饰层降级不许拖垮工具面（2026-11-03 G10 抓到的第三个真问题）
     *
     * 场景：宿主只实现了 `systemPrompt.section`，没实现 `.context`
     * （ours/session-memory.js 要的就是 context）。真实事故里这会让
     * `installSessionMemory` 在 try 之外抛 → 整个 apply 失败 → **零工具**。
     *
     * 判据：err 为空（apply 不失败）+ 仍然注册出 1 个工具（ctx）+ 有一条 warn 记下降级。
     * 这条断言的价值在于它**故意造一个残缺宿主** —— 正常桩永远造不出这个场景。
     */
    await check('⑧ 宿主残缺（只有 section 无 context）时工具面仍完整', async () => {
        const host = makeHost();
        // 把 systemPrompt 改成"残缺"：去掉 context 与 getContextOrder
        const degradedCtx = {
            ...host.ctx,
            get: (svc, dflt) => {
                if (svc === 'systemPrompt') {
                    return { section: () => () => {}, getSectionOrder: () => SECTION_ORDER_FALLBACK_GUESS };
                }
                return host.ctx.get(svc, dflt);
            },
        };
        const registered = [];
        const noop = () => () => {};
        const ctx2 = {
            ...degradedCtx,
            get: (svc, dflt) => {
                if (svc === 'tools') return { register: (def) => { registered.push(def.name); return noop(); }, get: () => ({ name: 'ctx' }) };
                return degradedCtx.get(svc, dflt);
            },
        };
        let err = '';
        try { await plugin.apply(ctx2, { enabled: true, storageDir: path.join(RUN, 'lib3') }, {}); }
        catch (e) { err = e.message; }
        // ★ ctx2 的 effect 是 `...degradedCtx` 带过来的，实际写进 `host.disposers`。
        //   所以这里登记 **host**（它的 disposers 里有第三次 apply 的卸载函数），
        //   而不是登记 ctx2（它自己没有 disposers 数组，会让 finally 迭代时报错）。
        appliedHosts.push(host);
        if (err !== '') throw new Error(`装饰层缺失导致 apply 整体失败：${err}`);
        const names = registered.sort();
        if (names.length !== 1 || names[0] !== 'ctx') {
            throw new Error(`装饰层缺失时工具面不全：${names.join(',') || '(无)'}`);
        }
        const warns = host.logs.filter((l) => l.includes('unavailable'));
        if (warns.length === 0) throw new Error('降级了却没留 warn（下一个排障的人会不知道）');
    })
    /**
     * ⑨ P5 审批流在装好的链路上生效（沙箱归一的平权判据）。
     *
     * 桩宿主带齐审批三件（approval.request / sandboxPolicy.resolve / agent）。
     * 判据一条不漏：
     *   a. 批了 → callTool 收到 meta.policyOverride = 批准的 mode，且转发参数里
     *      **没有** sandbox_permissions/justification（那是给宿主的，不是 op 参数）；
     *   b. 没批（rejected）→ execute 抛，文案含"rejected"与"stop and explain"（宿主原话语义）；
     *   c. 单键（只有 sandbox_permissions 没 justification）→ 校验抛，不触审批；
     *   d. 宿主没组审批服务 → 带申请得到可读拒绝（绝不静默当没申请）。
     */
    await check('⑨ 审批流：批准透传 policyOverride+剥键 / 拒绝抛 / 坏对抛 / 无服务可读拒绝', async () => {
        // 用**真的 createEscalator**（校验/宽度序/四结局都在真码里跑），只桩宿主服务面。
        const { toDefinition } = await import(pathToFileURL(path.join(STAGED, 'platform', 'tool-def.js')).href);
        const { createEscalator } = await import(pathToFileURL(path.join(STAGED, 'platform', 'escalation.js')).href);
        const approvals = [];
        let verdict = 'allowed-once';
        const mockCtx = {
            logger: { debug() { } },
            get: (svc, dflt) => {
                if (svc === 'approval') return { request: async (req) => { approvals.push(req); return verdict; } };
                if (svc === 'sandboxPolicy') return { resolve: async () => ({ mode: 'workspace-write', workspaceRoot: RUN }) };
                return dflt;
            },
        };
        const escalate = createEscalator({ ctx: mockCtx });
        if (typeof escalate !== 'function') throw new Error('createEscalator 在有审批服务的桩下不该返回 undefined');
        const seen = [];
        const deps = {
            callTool: async (name, args, signal, meta) => {
                seen.push({ args, meta });
                return { content: [{ type: 'text', text: `ran ${args.code ?? ''}` }] };
            },
            escalate,
        };
        const def = toDefinition({ name: 'ctx', description: 'd', inputSchema: { type: 'object', properties: {} } }, deps, { cjkAdapt: false });
        const exec = { signal: undefined, agent: { session: { id: 'gate-9' } }, callId: 'call-9' };

        // a. 批准：policyOverride 进 meta，两个申请键**不进**转发参数（那是给宿主的）
        await def.execute({ op: 'run', code: 'x', sandbox_permissions: 'danger-full-access', justification: '门⑨a' }, exec);
        if (approvals.length !== 1 || approvals[0].callId !== 'call-9') {
            throw new Error(`批准路径没走审批或没挂 callId：${JSON.stringify(approvals)}`);
        }
        if (!/允许本次操作/.test(String(approvals[0].displayReason?.zh))) throw new Error('弹卡缺中文文案');
        const last = seen[seen.length - 1];
        if (last.meta?.policyOverride !== 'danger-full-access') {
            throw new Error(`批准的 mode 没递进引擎：meta=${JSON.stringify(last.meta)}`);
        }
        if ('sandbox_permissions' in last.args || 'justification' in last.args) {
            throw new Error(`申请键漏进 op 参数：${JSON.stringify(last.args)}`);
        }

        // b. 拒绝：抛，文案含宿主原话语义
        verdict = 'rejected';
        let errText = '';
        try { await def.execute({ op: 'run', code: 'x', sandbox_permissions: 'danger-full-access', justification: '门⑨b' }, exec); }
        catch (e) { errText = e.message; }
        if (!/rejected/.test(errText) || !/stop and explain/.test(errText)) throw new Error(`拒绝文案不对：${errText.slice(0, 120)}`);

        // c. 单键：校验先炸，不触审批（validateEscalationArgs 在真 escalate 的第一行）
        const before = approvals.length;
        errText = '';
        try { await def.execute({ op: 'run', code: 'x', sandbox_permissions: 'danger-full-access' }, exec); }
        catch (e) { errText = e.message; }
        if (!/requires a justification/.test(errText)) throw new Error(`单键没先报缺 justification：${errText.slice(0, 120)}`);
        if (approvals.length !== before) throw new Error('坏对不该触发审批弹卡');

        // c2. 不更宽的"申请"（read-only < workspace-write）→ 宿主语义：拒于宽度序，不弹卡
        errText = '';
        try { await def.execute({ op: 'run', code: 'x', sandbox_permissions: 'read-only', justification: '门⑨c2' }, exec); }
        catch (e) { errText = e.message; }
        if (!/not strictly wider/.test(errText)) throw new Error(`窄申请没按宽度序拒：${errText.slice(0, 120)}`);
        if (approvals.length !== before) throw new Error('窄申请不该弹卡');

        // d. 宿主没组审批服务：带申请 → 可读拒绝（绝不静默当没申请）
        const def2 = toDefinition({ name: 'ctx', description: 'd', inputSchema: { type: 'object', properties: {} } },
            { callTool: deps.callTool }, { cjkAdapt: false });
        errText = '';
        try { await def2.execute({ op: 'run', code: 'x', sandbox_permissions: 'danger-full-access', justification: '门⑨d' }, exec); }
        catch (e) { errText = e.message; }
        if (!/unavailable on this host/.test(errText)) throw new Error(`无审批服务没给可读拒绝：${errText.slice(0, 140)}`);

        // e. 不带申请 = 完全不碰审批（正常路径零开销）
        const n0 = approvals.length;
        await def.execute({ op: 'index', content: '# 门⑨e', source: 'gate-9-e' }, exec);
        if (approvals.length !== n0) throw new Error('没申请也走了审批');
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`G10 真机安装链路：${n} 项 / 失败 ${failed}`);
    if (failed > 0) {
        console.log('失败 —— 装上去会没有工具，别装。');
        process.exitCode = 1;
    }
    else {
        console.log('G10 全绿 ✅ —— 走真实解析路径也能注册出 1 个工具（ctx）');
    }
}
catch (e) {
    console.error('install-path 崩了：', e.message);
    process.exitCode = 1;
}
finally {
    // ★★ 2026-11-04：**先跑 disposer 再删目录。**
    //   `plugin.apply` 经 `ctx.effect` 登记了卸载函数，里面会 `client.retire()`
    //   → 关掉 content.db 句柄。句柄开着时 rmSync 在受限宿主下静默 EPERM，
    //   目录就留下了（实测本门每跑一次留一个）。
    //   本门跑了三次 apply（⑤ / ⑦ / ⑧），所以要把三份 disposer 都排掉。
    for (const host of appliedHosts) {
        for (const d of host.disposers) {
            try { if (typeof d === 'function') d(); } catch { /* 已卸过 */ }
        }
        host.disposers.length = 0;
    }
    appliedHosts.length = 0;
    try {
        releaseTempRunDir(RUN);
        delete globalThis.__registered;
    }
    catch { /* 忽略 */ }
}
