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
 * 13-sandbox — 执行面（kind: impl，deps: ['core']）
 *
 * 干什么：把「在受限子进程里跑一段代码、只回它打印的东西」做成一块不依赖宿主的积木。
 *        进来 `{language, code, file, timeoutMs, env, signal, session, policyOverride}`，
 *        出去 `{stdout, stderr, exitCode, timedOut, truncated, bytes, command}`。
 *        ★ 2026-11-04 P4 起这是**全宿主唯一的执行面**：桥侧 guard（sandbox-exec.js）
 *        已删，受限会话的 op:"run" 也走这里（旧文里"引擎全程没参与"成历史）。
 * 为什么这样：1.2.2 的执行面散在 `executor.js`(678 行) + `runtime.js` + `runPool.js` +
 *            `truncate.js` + `exit-classify.js` 五件里，且 `ctx_execute` 的 javascript 被桥侧
 *            `sandboxGuard` 短路，引擎全程没参与（`by_tool` 恒 0、`bytes_sandboxed` 恒 0）。
 *            这里把它收成一块，桥只注入 confiner。
 * 边界：**不写库、不查库、不认识 ctx**。confiner 由入口注入（`init({confine})`），
 *       拿不到就退回原生 spawn（引擎独立跑走这条路）。
 *       ★ 2026-11-04 confine 契约按 2.0 `assembly/seam/spawn.ts` 重写（fail-closed）：
 *       `confine(argv, meta) => {argv} | null | Promise<同形>`；meta 带
 *       {cwd, timeoutMs, signal, session}。三种结局——返回 {argv}＝用重写后的 argv；
 *       返回 null/坏形状＝**拒跑**（CONFINER_UNAVAILABLE，绝不原样放行）；
 *       抛＝拒跑（DENIED_PATH）。真宿主的 confine 是 async，所以这里 **await**——
 *       旧版没 await，Promise 上取 .argv 恒 undefined，围栏形同虚设（本轮修掉的假围栏）。
 *
 * 对应需求：01-立项书 §4.1 块 13；04-工具需求书 §A1 `ctx_run`。
 */

import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { E, err } from '../../libs/err.js';
import { DEFAULTS, EXEC_LANGUAGES } from '../01-core/index.js';
import { buildCommand, detectRuntimes, setWarn, isBun } from './runtime-probe.js';
import { writeJsHost } from './js-host.js';
import { runProcess, DEFAULT_HARD_CAP_BYTES } from './spawn.js';
import { buildChildEnv } from './env.js';
import { writeScript } from './script-file.js';
import { truncateOutput } from './truncate.js';
import { classifyNonZeroExit } from './exit-classify.js';
import { runPool } from './run-pool.js';

import { tempDir as resolveTempDir } from '../../libs/tempdir.js';

export const NAME = 'sandbox';

/** 返回给模型的单次输出上限（2.0 `OUTPUT_CAP`）。超了按码点截断，不劈 CJK/emoji。 */
export const MAX_OUTPUT_BYTES = 16384;
/** rustc 编译的独立超时：编译挂住不该把整个调用拖死。 */
const RUSTC_COMPILE_TIMEOUT_MS = 60_000;
/** 受限模式下捕获上限（guard 四年实撞值，P1 下沉）：超限停收、进程跑完。
 *  非受限（引擎独立跑/full-access）传 0 = 不设捕获顶，只留 hardCap 防内存炸。 */
export const CONFINED_CAPTURE_CAP_BYTES = 512 * 1024;
/** 受限模式的 wall clock 默认与钳位（guard 同款）：120s 默认、1s~30min。
 *  非受限维持 DEFAULTS.TOOL_TIMEOUT_MS（10min）不动 —— 那是独立跑的语义。 */
const CONFINED_DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 30 * 60_000;

export const INVARIANTS = Object.freeze([
    'argv 直启 + shell:false，永不用 shell:true 跑命令（注入面）',
    '12 种执行语言一个不裁，探测不到就如实报 RUNTIME_MISSING，不假装成功',
    'javascript 的 execPath 兜底必须标 source=execPath-fallback 并告警，不静默当用户装的 node',
    '超时杀的是进程树（Windows taskkill /F /T，POSIX 杀进程组），不留孤儿',
    '输出按码点截断，绝不劈开 CJK/emoji（最后一个字符必是完整码点）',
    'MINGW / hermes Git Bash 一律拒绝当 shell（受限令牌下必死 0xC0000022）',
    '★ confine 是 fail-closed 的：坏形状/抛错/null 一律拒跑，绝不原样放行未重写的 argv（P1 修的假围栏）',
    'confine 的返回可能是 Promise，必须 await（真宿主 confine 是 async）',
    '受限模式只跑实测可起的语言（confinedLanguages 注入），其余 LANGUAGE_NOT_CONFINABLE 带指路拒言',
]);

const noop = () => { };

const state = {
    confine: null,
    log: null,
    tempDir: '',
    fence: null,
    workspaceRoot: null,
    probe: null,
    /** ★ P1：受限能力由平台层声明 —— confined=true 时启用语言白名单/512KB 顶/120s 默认/拒 background。 */
    confined: false,
    confinedLanguages: null,
};

/**
 * 初始化。confiner 由入口注入；拿不到就退回原生 spawn。
 * @param {{confine?:Function, log?:object, tempDir?:string, fence?:Function, workspaceRoot?:string,
 *          confined?:boolean, confinedLanguages?:string[]}} [deps]
 */
export async function init(deps = {}) {
    state.confine = typeof deps.confine === 'function' ? deps.confine : null;
    state.log = deps.log ?? null;
    state.tempDir = deps.tempDir || resolveTempDir();
    // `file` 的围栏：优先用入口注入的 02-project `isInside`；没注入就用块内 realpath 判定
    state.fence = typeof deps.fence === 'function' ? deps.fence : null;
    state.workspaceRoot = deps.workspaceRoot ?? null;
    state.confined = deps.confined === true && state.confine !== null;
    state.probe = null; // ★ 先清缓存再按 probe 定白名单：否则白名单会读到上一轮 init 的陈旧探测结果
    // ★ R14（2026-11-05 维护方质疑「CTX不能跑PWSH？」）：受限白名单原来**硬编码只放 javascript**。
    //   实际能力远不止：受限令牌下匿名管道不给，但**文件描述符重定向可行**（R11 已实测），
    //   所以任何"能把输出写文件"的运行时都能跑 —— 实测 node 与 pwsh 都成。
    //   现在两层：
    //     ① 平台层显式给了 confinedLanguages → 以它为准（宿主有更精确证据时用它的）；
    //     ② 没给 → 不再写死 javascript，而是从**探测结果里挑出真正能起的**（probe 已挡住
    //        Store 桩 / MSYS 假阳性 / 非 .exe 的 bat），再叠加一条"javascript 永远在内"
    //        的兜底（它走 DSH 受管 node，不依赖 PATH）。
    //   这样 availableLanguages() 报 ok 的语言，和 run() 白名单放行的语言**不再是两张皮**
    //   —— 原来正是两张皮，模型看到 perl ok:true 却拿到 LANGUAGE_NOT_CONFINABLE。
    if (Array.isArray(deps.confinedLanguages) && deps.confinedLanguages.length > 0) {
        state.confinedLanguages = new Set(deps.confinedLanguages);
    }
    else {
        const probed = probeRuntimes().languages.filter((l) => l.ok).map((l) => l.language);
        const set = new Set(probed);
        set.add('javascript'); // 兜底：受管 node 不走 PATH，万一探测漏了也得能跑
        state.confinedLanguages = set;
    }
    setWarn((m) => (state.log?.warn ? state.log.warn(m) : console.error(`[warn][sandbox] ${m}`)));
    // ★ R17（2026-11-05 维护方质问「谁告诉你 CTX 没有后台任务？」）：后台能力**已经存在**，
    //   原来唯一的阻碍是「本块没接宿主作业体系，于是无条件拒」。
    //   jobHost 由入口从平台层透传（`ctx.jobs` 适配器）；为 null = 宿主没组作业服务。
    //   注意：**不再因为 confined 就拒** —— 拒的唯一依据是"拿不到作业宿主"。
    state.jobHost = deps.jobHost ?? null;
    return { name: NAME, ready: true };
}

/** 探测缓存：同一进程内 PATH 不变，探测一次就够（但 init 后强制重探）。 */
function probeRuntimes() {
    if (!state.probe) {
        state.probe = detectRuntimes(process.env, (m) => state.log?.debug?.(m));
    }
    return state.probe;
}

/** 12 语言矩阵：`[{language, ok, path, version, source}]`。 */
export function availableLanguages() {
    return probeRuntimes().languages.map((l) => ({
        language: l.language,
        ok: l.ok,
        path: l.path,
        version: l.version,
        source: l.source,
    }));
}

/** 数值钳位：非有限数退回 lo（guard 的 timeoutOf 同款判据）。 */
function clamp(value, lo, hi) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return lo;
    return Math.min(Math.trunc(value), hi);
}

/** realpath 前缀判定：防符号链接逃逸，前缀必须带分隔符（`/../../evil` 不算 inside）。 */
function isInsideRoot(root, target) {    try {
        const r = realpathSync(root);
        const t = realpathSync(target);
        const rel = relative(r, t);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    }
    catch {
        return false; // 任一端不存在/不可解析 → 不算 inside（围栏宁可拒）
    }
}

/**
 * 统一失败形状：既保留任务书要求的 7 个字段，又带 `ok:false` + `code` 让调用方能判。
 * 登记过的码（libs/err.js）正文与「怎么改」一律取自那里，调用方只补事实；没登记的就地给可读文案。
 *
 * ★ R16（2026-11-05 维护方质问「这个错误提示这么多？你要灌爆自己的上下文？」）：
 *   message 与 fix **不许装同一段话**。工具层的渲染是
 *   `out.fix ? message + '\n' + fix : message` —— 两个字段填同样内容，模型就看到两遍，
 *   再加上 `err()` 把 fix 顶到 message 第一行，同一句话会**出现三次**（实测 400+ 字）。
 *   新规矩：登记码的 message **只放 details 里的事实**（没有事实就是空串），fix 才是那句「怎么改」。
 *   没登记码的 message 由调用点给（它本来就没 fix）。
 */
function fail(code, message, fields = {}, details = fields) {
    const registered = Object.prototype.hasOwnProperty.call(E, code);
    let text = message;
    if (registered) {
        // 只用事实部分（err() 的第二行起）；空 details → 空串 → 工具层只渲染 fix 一遍
        const e = err(code, details);
        const nl = e.message.indexOf('\n');
        text = nl >= 0 ? e.message.slice(nl + 1).trim() : '';
    }
    return {
        ok: false,
        code,
        message: text,
        fix: registered ? E[code].fix : undefined,
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        truncated: false,
        bytes: 0,
        command: null,
        pid: null,
        backgrounded: false,
        ...fields,
    };
}

/** rust 特例：先 rustc 编译，再跑产物（1.2.2 `#compileAndRun`）。 */
function compileRust(scriptPath, cwd, timeoutMs, rt) {
    const binSuffix = process.platform === 'win32' ? '.exe' : '';
    const binPath = scriptPath.replace(/\.rs$/, '') + binSuffix;
    try {
        execFileSync(rt.path, [scriptPath, '-o', binPath], {
            cwd,
            timeout: Math.min(timeoutMs ?? RUSTC_COMPILE_TIMEOUT_MS, RUSTC_COMPILE_TIMEOUT_MS),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
    }
    catch (e) {
        const detail = e?.stderr || e?.message || String(e);
        return { argv: null, stderr: `Compilation failed:\n${detail}`, exitCode: 1 };
    }
    return { argv: [binPath], stderr: '', exitCode: null };
}

/**
 * 跑一段代码。
 * @param {object} opts
 * @param {string} [opts.language] 12 语言之一，默认 javascript
 * @param {string} [opts.code] 脚本正文
 * @param {string} [opts.file] 工作区内的一个文件；给了就把绝对路径塞进子进程的 `CTX_FILE`
 * @param {number} [opts.timeoutMs] 默认 `DEFAULTS.TOOL_TIMEOUT_MS`（10 分钟）
 * @param {Record<string,string>} [opts.env] 追加/覆盖子进程 env
 * @param {boolean} [opts.background] 后台跑，立刻回 pid
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxOutputBytes] 返回给模型的字节上限
 */
export async function run(opts = {}) {
    const {
        language = 'javascript',
        code,
        file,
        timeoutMs,
        env,
        background = false,
        cwd,
        maxOutputBytes = MAX_OUTPUT_BYTES,
        signal,
        session,
        policyOverride,
        // ★ R17：`agent` 是作业归属（owner）。tool-def → engine-client → 这里一路传。
        agent,
    } = opts;

    // ⓪ 已取消就不开工（2.0 seam 同款判序：先看撞进来时是否早已 abort）。
    if (signal?.aborted) {
        return fail('CANCELLED', '', { signal: 'aborted' }, { signal: 'aborted' });
    }

    // ⓪b ★ 逐调用探本会话的执法形态（P2 的 describe 契约）。
    //   有 describe（真宿主 confiner）→ 按会话现解：full-access 的会话拿 'none'，
    //   不受白名单/512KB 顶约束；受限会话拿 'confined'。describe 给 null = 解析失败
    //   → fail-closed 拒跑。无 describe（selftest/独立跑的静态注入）→ 用 init 的 confined 旗。
    let enforcement = state.confined ? 'confined' : 'none';
    let dynRoot = null;
    // ★ 2026-11-06：**"要不要走 confiner"与"这一档受不受围栏"是两件事，分开判**。
    //   · `enforcement`/`confined` = 受不受围栏（决定白名单/超时钳位/捕获顶/file 围栏）；
    //   · `useConfiner` = ⑥ 步要不要把 argv 交给 confiner 重写。
    //   为什么要分开：`confined=false` 有两种成因 ——
    //     ① 真宿主说"这一档不受围栏"（FA）→ **不该**进 confine（宿主沙箱只有两档方言，
    //       FA 进去会撞 runner.js:96 白名单 → unknown mode + exit 127）；
    //     ② 静态注入的 confiner 没有 describe（selftest 场景）→ **该**进 confine
    //       （fail-closed：confine 抛错/返坏形状必须被拒，绝不许"跳过重写继续起"）。
    //   早先把两者合成一个 `confined`，②被当成① → 13-sandbox 的 4 条契约断言全部失效。
    //   判据：**只有问过 describe 且它明确说 'none' 才跳过**；没问过 = 一律走。
    let useConfiner = true;
    if (typeof state.confine?.describe === 'function') {
        const d = await state.confine.describe({ session, signal, policyOverride });
        if (d === null || d === undefined) {
            return fail('CONFINER_UNAVAILABLE', '', { stage: 'describe' }, { stage: 'describe' });
        }
        enforcement = d.enforcement === 'none' ? 'none' : 'confined';
        dynRoot = d.workspaceRoot ?? null;
        // ★ FA 档（宿主说这一档不受围栏）→ 不走 confine。
        //   DSH 自己的 provider（pwsh/bash）同款：`if (mode === "danger-full-access") return super.execute()`。
        useConfiner = enforcement !== 'none';
    }
    const confined = enforcement === 'confined';

    // 受限模式的超时钳位（guard 同款）：默认 120s、钳到 1s~30min；
    // 非受限维持 DEFAULTS.TOOL_TIMEOUT_MS（独立跑语义）。
    const effTimeout = confined
        ? clamp(timeoutMs ?? CONFINED_DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
        : (timeoutMs ?? DEFAULTS.TOOL_TIMEOUT_MS);

    // ① 语言枚举
    if (!EXEC_LANGUAGES.includes(language)) {
        return fail('UNKNOWN_LANGUAGE', `language 只认这 12 个：${EXEC_LANGUAGES.join(' / ')}`);
    }
    // ①b ★ 受限白名单（P1 下沉）：restricted token 只实测过 node 能起，
    //     MINGW bash 拿 0xC0000022 根本起不来 —— 未验证的语言一律拒 + 指路 pwsh。
    //     这比"尝试起、失败报 RUNTIME_MISSING"诚实：那条会说谎（明明是可起与否的问题报成没装）。
    if (confined && !state.confinedLanguages.has(language)) {
        return fail('LANGUAGE_NOT_CONFINABLE', '', { language, confined: true }, {
            language,
            allowed: [...state.confinedLanguages],
        });
    }
    // ①c ★ R17（2026-11-05 维护方质问「谁告诉你 CTX 没有后台任务？」）：
    //   原来这里写的是 `if (confined && background) 拒`，文案还谎称
    //   「受限宿主里后台跑没有作业体系可跟踪」——**宿主一直有**（ctx.jobs /
    //   dsh-jobs-local / dsh-tool-jobs，job_* 就在工具表里）。真实原因是本块没接。
    //   现在判据换成**能力**而不是**受限与否**：拿得到作业宿主就放行，拿不到才拒，
    //   而且拒的理由必须说实话（"本包未接"而不是"宿主没有"）。
    if (background && state.jobHost === null) {
        return fail('BACKGROUND_DENIED', '', { jobHost: false }, { jobHost: false });
    }
    if (typeof code !== 'string' || code.length === 0) {
        return fail('NO_INPUT', '', {}, { hint: 'code 必填：要跑的脚本正文（file 只用来给脚本喂一个数据文件路径）' });
    }

    // ② 运行时探测
    const probe = probeRuntimes();
    const rt = probe.runtimes[language];
    if (!rt?.path) {
        return fail('RUNTIME_MISSING', '', { language }, {
            language,
            available: probe.languages.filter((l) => l.ok).map((l) => l.language),
        });
    }

    const workdir = cwd ?? process.cwd();

    // ③ file：绝对路径 + 围栏 + 塞进 CTX_FILE（2.0 语义，不把整份文件塞进脚本正文）
    //    围栏根：describe 的逐会话 workspaceRoot 优先，退 init 注入的 state.workspaceRoot。
    const fenceRoot = dynRoot ?? state.workspaceRoot;
    const extraEnv = {};
    let fileAbs = null;
    if (file !== undefined) {
        // ★ R1（2026-11-04 测试汇总 P0-2）：原来是 `join(workdir, file)`。
        //   `path.join` 只做字符串拼接，**没有"绝对路径覆盖前缀"的语义**：传进来的
        //   `F:\workspace\...\PENDING.md` 会被拼成 `<cwd>\F:\workspace\...\PENDING.md`，
        //   于是**任何绝对路径入参都必然落在围栏外**，报 DENIED_PATH，而且把拼坏的
        //   假路径当成"被拒的文件"回给模型（指错对象，模型照着改只会更错）。
        //   正确语义：绝对路径原样用（resolve 归一 `..`/分隔符），相对路径才按 workdir 解析。
        fileAbs = isAbsolute(file) ? resolve(file) : resolve(workdir, file);
        const denied = state.fence
            ? !state.fence(fileAbs)
            : (fenceRoot ? !isInsideRoot(fenceRoot, fileAbs) : false);
        if (denied) {
            return fail('DENIED_PATH', '', { file: fileAbs, root: fenceRoot },
                { file: fileAbs, root: fenceRoot });
        }
        if (!state.fence && !fenceRoot) {
            // 判不了就放行，但必须留痕 —— 不许静默放行
            state.log?.warn?.(`file=${fileAbs} 没有可判的围栏（init 未注入 fence / workspaceRoot），本次放行`, 'sandbox-no-fence');
        }
        extraEnv.CTX_FILE = fileAbs;
    }

    // ④ 落临时脚本（后面整段包在 try 里：任何意外都转成结构化失败，不把栈抛给模型）
    let tmpDir = null;
    try {
        tmpDir = mkdtempSync(join(state.tempDir, '.ctx-sandbox-'));

        // ④b/⑤ ★ javascript 走双宿主（P3 下沉）：装配根 type:module 把 .js 按 ESM 解析，
        //   require + 顶层 await 的 CommonJS 味代码直接崩 —— ESM 直起、CJS 味走 entry.mjs 宿主。
        let argv;
        let scriptPath = null;
        if (language === 'javascript') {
            const host = writeJsHost(tmpDir, code, workdir, rt.path, isBun(rt.path));
            argv = [rt.path, ...host.rest];
        }
        else {
            scriptPath = writeScript(tmpDir, code, language, {
                runtimes: probe.runtimes,
                projectRoot: workdir,
            });
            argv = buildCommand(probe.runtimes, language, scriptPath);
        }
        if (argv[0] === '__rust_compile_run__') {
            const compiled = compileRust(scriptPath, workdir, effTimeout, rt);
            if (!compiled.argv) {
                return fail('COMPILE_FAILED', 'rust 编译失败', {
                    stdout: '', stderr: compiled.stderr, exitCode: compiled.exitCode ?? 1,
                });
            }
            argv = compiled.argv;
        }

        // ⑥ ★ confiner（P1 重写：契约照 2.0 assembly/seam + 真宿主 async，fail-closed）
        //    confine(argv, meta) 可能同步返回，也可能返回 Promise —— 一律 await。
        //    三种结局：{argv:[...]}＝用重写后的；null/坏形状＝CONFINER_UNAVAILABLE；
        //    抛＝DENIED_PATH（带拒因）。**任何非 {argv} 的结果都不许拿原 argv 起进程**——
        //    旧版 `out && Array.isArray(out.argv)` 判失败时是"跳过重写继续起"，那是假围栏。
        //
        // ★ 2026-11-06（施工单见开发日志同日节）：**FA 档不 confine**。
        //   判据是 `useConfiner`（⓪b 算好），**不是** `confined` ——
        //   `confined` 表达"受不受围栏"，`useConfiner` 表达"要不要把 argv 交给 confiner 重写"，
        //   两者在"静态注入 confiner（无 describe）"场景下会分叉（详见 ⓪b 注释）。
        //   旧写法 `if (state.confine)` 把 danger-full-access 也送进 confine，
        //   而宿主沙箱 runner 只有 read-only|workspace-write 两档方言
        //   （runner.js:96 白名单）→ FA 原值透传 `--mode` → `unknown mode` + exit 127
        //   → **完全权限反而最没权限**。
        //   DSH 自己的 provider（pwsh/bash）就是 FA 档短路不 confine 的；
        //   `CTX工具结构图.md` §三 ⓪b/§三末也早写明 FA = "无沙箱"。
        //   沙箱档（read-only/workspace-write）行为**完整不变**。
        if (state.confine && useConfiner) {
            let rewritten;
            try {
                rewritten = await state.confine(argv, { cwd: workdir, timeoutMs: effTimeout, signal, session, policyOverride });
            }
            catch (e) {
                return fail('DENIED_PATH', '', { deniedCode: e?.code ?? 'DENIED' },
                    { deniedCode: e?.code ?? 'DENIED', reason: String(e?.message ?? e) });
            }
            if (rewritten === null || rewritten === undefined ||
                !Array.isArray(rewritten.argv) || rewritten.argv.length === 0 ||
                !rewritten.argv.every((a) => typeof a === 'string')) {
                return fail('CONFINER_UNAVAILABLE', '', { got: rewritten === undefined ? 'undefined' : (rewritten === null ? 'null' : 'bad-shape') },
                    { got: rewritten === null ? 'null' : (rewritten === undefined ? 'undefined' : JSON.stringify(rewritten?.argv)?.slice(0, 80)) });
            }
            argv = rewritten.argv;
        }

        // ⑥b ★ R17：**后台执行走宿主作业体系**（这是 background:true 的唯一正路）。
        //
        //   为什么在这里、而不是继续用 spawn.js 的 background 分支：
        //   spawn.js 的 background 只做「detach + 立刻回 pid + 流改空转排水」——
        //   子进程的输出**没有人收**。对"不占上下文"是好事，但对使用者是黑洞：
        //   模型拿不到完成通知、拿不到输出、也没法杀。
        //   宿主有完整作业体系（ctx.jobs + job_list/job_output/job_kill），
        //   接上之后：输出进作业环形缓冲（有界、按字节游标读），模型用 job_output 收，
        //   作业归属本 agent（会话级隔离），作业随 agent 销毁自动清理。
        //   所以 background 不再走下面的 runProcess —— 那条路的 background 分支
        //   现在只作为"没有作业宿主时的最后手段"保留（且上面已经拒掉了）。
        if (background) {
            const jobHost = state.jobHost;
            const childEnv = buildChildEnv(process.env, { ...extraEnv, ...(env ?? {}) }, tmpDir);
            // 作业的取消钩子要能杀掉子进程 —— 用 AbortController 串起来。
            const jobAbort = new AbortController();
            const onOuterAbort = () => { try { jobAbort.abort(); } catch { /* 忽略 */ } };
            if (signal) {
                if (signal.aborted) onOuterAbort();
                else { try { signal.addEventListener('abort', onOuterAbort, { once: true }); } catch { /* 非标准 signal */ } }
            }
            const jobId = jobHost.start({
                kind: 'ctx',
                label: `${language}: ${String(code).split('\n')[0].slice(0, 60)}`,
                owner: agent ?? session ?? undefined,
                run: (handle) => {
                    // 起进程（**前台收集，但结果回灌作业环形缓冲**）：
                    // 作业输出有界（宿主 ring 自己截断），所以这里不设 capture 帽。
                    const done = (async () => {
                        try {
                            const r = await runProcess(argv, {
                                cwd: workdir,
                                env: childEnv,
                                timeoutMs: effTimeout,
                                hardCapBytes: DEFAULT_HARD_CAP_BYTES,
                                captureCapBytes: 0,
                                signal: jobAbort.signal,
                                background: false,
                            });
                            if (r.stdout) handle.append(String(r.stdout));
                            if (r.stderr) handle.append(String(r.stderr), { channel: 'stderr' });
                            const status = r.killed === 'cancel' ? 'killed'
                                : (r.exitCode === 0 ? 'completed' : 'failed');
                            return {
                                status,
                                detail: r.killed === 'cancel' ? 'cancelled'
                                    : `exit=${r.exitCode}${r.timedOut ? ' timedOut' : ''}`,
                            };
                        }
                        catch (e) {
                            return { status: 'failed', detail: String(e?.message ?? e) };
                        }
                        finally {
                            try { signal?.removeEventListener?.('abort', onOuterAbort); } catch { /* 忽略 */ }
                        }
                    })();
                    return {
                        done,
                        cancel: () => { try { jobAbort.abort(); } catch { /* 忽略 */ } },
                    };
                },
            });
            return {
                ok: true,
                backgrounded: true,
                jobId,
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                truncated: false,
                bytes: 0,
                command: argv,
                pid: null,
                runtime: rt.source,
                // ★ 提示模型下一步怎么收：不是"去用 pwsh"，而是"用 job_output"。
                hint: `后台作业已开：job_id=${jobId}。用 job_output 收输出，job_kill 停它。`,
            };
        }

        // ⑦ 起进程
        const result = await runProcess(argv, {
            cwd: workdir,
            env: buildChildEnv(process.env, { ...extraEnv, ...(env ?? {}) }, tmpDir),
            timeoutMs: effTimeout,
            hardCapBytes: DEFAULT_HARD_CAP_BYTES,
            captureCapBytes: confined ? CONFINED_CAPTURE_CAP_BYTES : 0,
            signal,
            background,
        });

        if (result.killed === 'cancel' || signal?.aborted) {
            return fail('CANCELLED', '', { signal: 'aborted' }, { signal: 'aborted' });
        }

        // ★ R10（2026-11-05 维护方质疑 + 实测证伪）：**不许再用 stderr 里出现 "EPERM" 字样判管道问题**。
        //   旧判据 `result.error === 'EPERM' || /EPERM/.test(result.stderr)` 有两个致命缺陷：
        //     ① 子进程**正常跑完但输出里恰好含 "EPERM" 三个字母**（任何日志/错误转储都会命中）
        //        就被改判成"宿主令牌不给匿名管道"，把真实结果整个吞掉；
        //     ② 子进程**写工作区外被文件系统拒绝**时，真实错误是 EPERM + syscall:open + path，
        //        被这条改判后 path 丢失，模型看到的是"沙箱装配坏了去看 confiner"，而不是
        //        "这个路径不可写、要写就提权" —— 把「权限问题」错报成「引擎故障」，误导程度最高。
        //   现在只有「spawn 本身没起来」才可能是管道/令牌问题：`result.error` 只在 spawn.js 的
        //   catch 分支和 'error' 事件里赋值（那时 pid 为 null、stdout 为空），据此判死。
        const spawnNeverStarted = result.error !== null && result.error !== undefined
            && result.pid === null && String(result.stdout ?? '') === '';
        if (spawnNeverStarted) {
            if (result.error === 'EPERM') {
                return fail('HOST_PIPE_DENIED', '', { stderr: result.stderr });
            }
            // 其它起不来的原因（EINVAL / ENOENT / SPAWN_FAILED）：如实回，别冒充管道问题。
            return fail('SANDBOX_ERROR', `子进程起不来（${result.error}）：${String(result.stderr ?? '').trim() || '无 stderr'}`,
                { stderr: result.stderr, cause: result.error });
        }
        // ★ 子进程跑起来了但**非零退出**且 stderr 里带文件系统拒绝特征（EPERM/EACCES）：
        //   这是「沙箱不让写工作区外」，给一句固定指路即可，**不夹带路径/mode/围栏根**。
        //   R16（2026-11-05 需求方要求）：报错会进上下文，事实由模型自己记（路径是它刚传的），
        //   引擎只回答"路被封了 + 怎么开"，一句话就够，重复三遍最烧 token。
        if (result.exitCode !== 0 && /EPERM|EACCES/.test(String(result.stderr ?? ''))) {
            return fail('WRITE_OUTSIDE_SANDBOX', '', {});
        }

        // ⑧ 按码点截断（stdout/stderr 各自上限）
        const rawOutBytes = Buffer.byteLength(result.stdout, 'utf8');
        const rawErrBytes = Buffer.byteLength(result.stderr, 'utf8');
        const stdout = truncateOutput(result.stdout, maxOutputBytes);
        const stderr = truncateOutput(result.stderr, maxOutputBytes);

        const out = {
            ok: true,
            stdout,
            stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: (rawOutBytes + rawErrBytes) > maxOutputBytes,
            bytes: Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8'),
            command: argv,
            pid: result.pid,
            backgrounded: result.backgrounded,
            runtime: rt.source, // 'path' | 'dsh-managed' | 'execPath-fallback' | 'shell-resolution'
        };
        return out;
    }
    catch (e) {
        // 未预期的错：转成结构化失败，不把栈抛给模型。
        // 这里不走 err()：code 可能是任意错误码，硬套登记文案会盖掉真正的错误信息，
        // 所以用专属码 SANDBOX_ERROR，原码放进 cause。
        return fail('SANDBOX_ERROR', `${e?.message ?? e}`,
            { stderr: e?.stderr ?? undefined, cause: e?.code ?? undefined });
    }
    finally {
        // 后台跑的不删：子进程可能还要用里面的文件
        if (!background && tmpDir) {
            try {
                rmSync(tmpDir, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 8 : 2, retryDelay: 100 });
            }
            catch { /* 尽力而为，OS 会回收 */ }
        }
    }
}

/**
 * 批量跑 shell 命令（原 `ctx_batch_execute`）。
 *
 * ★ R8（2026-11-04 测试汇总）：这里原来是**静默失败**的重灾区 —— 批量固定走
 *   `language:'shell'`，而受限会话的白名单只有 node → `run()` 对每条命令都返回
 *   `fail('LANGUAGE_NOT_CONFINABLE')`，这个失败被 `runPool` 妥妥地装进
 *   `settled[].value.ok=false`，14-tools 再把它 `render()` 成一段"看起来正常"的
 *   结构体回给模型。**表面成功、实际一条没跑**，模型只能反复重试同一条路。
 *
 *   两条修正（都不改批量能力本身，只改"失败必须能被看见"）：
 *     ① 受限会话**起跑前**就判掉，抛带指路的错（不许起一堆注定失败的活）；
 *     ② 批量整体失败（每条都是 ok:false）时**抛错**，不许把失败当结果返回。
 *
 * @param {{commands:string[], timeoutMs?:number, concurrency?:number, cwd?:string, env?:object,
 *          signal?:AbortSignal, session?:unknown}} opts
 */
export async function runBatch(opts = {}) {
    // ★ 2026-11-06：接住 policyOverride（教学单见开发日志同日节）。
    //   原来解构里没这一项 → 第三方 /14-tools 用 `...rt` 展开传来的 policyOverride
    //   **在解构处被丢弃**，批量路径的提权恒丢失（code 形态通、commands 形态不通）。
    //   同型断链：跨层传上下文靠手写列举，漏一项不报错（见 engine-client 那次）。
    const { commands, timeoutMs, concurrency = 4, cwd, env, signal, session, policyOverride } = opts;
    if (!Array.isArray(commands)) {
        return { settled: [], effectiveConcurrency: 0, capped: false, error: 'commands 必须是数组' };
    }

    // ① 受限白名单预判：批量恒走 shell，受限令牌下必死 → 起跑前拒，给确定文案。
    if (state.confined && !state.confinedLanguages.has('shell')) {
        throw err('BATCH_NOT_CONFINABLE', {
            confined: true,
            commands: commands.length,
            allowed: [...state.confinedLanguages],
        });
    }

    const jobs = commands.map((cmd) => () => run({
        language: 'shell',
        code: String(cmd),
        timeoutMs,
        cwd,
        env,
        signal,
        session,
        // ★ 2026-11-06：policyOverride 必须逐条转给 run()（批量里的每条都是一次调用）。
        //   漏了它 = 批量整条路径的提权失效（开发日志同日节 §二）。
        policyOverride,
    }));
    const pool = await runPool(jobs, { concurrency });

    // ② 整体失败 → 抛错（把 settled 里的结构性失败救出来，不冒充结果）。
    const values = pool.settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
    const okCount = values.filter((v) => v && v.ok !== false).length;
    if (values.length > 0 && okCount === 0) {
        const first = values.find((v) => v && v.ok === false);
        const rejected = pool.settled.find((s) => s.status === 'rejected');
        const code = first?.code ?? rejected?.reason?.code ?? 'SANDBOX_ERROR';
        const message = first?.message ?? rejected?.reason?.message ?? '批量执行全部失败';
        const fix = first?.fix ?? '';
        throw Object.assign(new Error(fix ? `${message}\n${fix}` : message), {
            code,
            details: { failed: values.length, of: commands.length },
        });
    }
    return pool;
}

/** 退出码分类（1.2.2 `exit-classify.js` 的同名面，供 14-tools 用）。 */
export { classifyNonZeroExit };
