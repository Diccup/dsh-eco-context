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
 * Post-execute output containment for DSH —— v2（2026-11-14，项目 07）
 *
 * 这一件现在干**两件事**，顺序固定：
 *   ① **入库优先**（新，对齐第三方项目 context-mode 2.1.10 的 PostToolUse replace 路径）：
 *      任何工具的结果超过阈值 → **整份写进 14 天临时库**，回给模型的是「source 标签 + 取回指路 + 一小段头部预览」。
 *   ② **截断兜底**（旧行为，原样保留）：入库不可用时，退回「头 HEAD_CHARS + 尾 TAIL_CHARS + spill 落盘」。
 *
 * 为什么要有 ①（真事，不是沿用参考实现）
 * ─────────────────────────────────────────────────────────
 * 修前入库只发生在 `ctx.run` 自己身上（`14-tools` 的 `INTENT_INDEX_BYTES = 5_000`）。
 * 宿主 `read` / `grep` / `pwsh` / 网页 / MCP 的大输出**从不入库**，只被本件砍成头尾，
 * 完整正文丢进 `%TEMP%\dsh-eco-context-spill`（20 个滚动淘汰）。
 * 于是：
 *   · 库里几乎只有 `run:` 源，别的大输出**检索不到**；
 *   · 14 天删线也管不到它们 —— 它们压根不在库里；
 *   · spill 目录一滚，内容就永久没了（连"曾经有过"都查不到）。
 * 第三方 /2.1.10 的 `PostToolUse` 正是拦所有工具：超过 `REPLACE_TRIGGER_BYTES`(4096) 就整份入索引。
 * 本件实现这一条（网页抓取腿不在本包范围内 —— 网页搜索由独立的 FP 插件提供）。
 *
 * 四条豁免（逐条对齐第三方 /`src/core/hooks/dispatch.ts` `postReplace`，语义不折扣）
 * ─────────────────────────────────────────────────────────
 *   1. `exec.name === 'ctx'` —— **我们自己的工具结果**。`run` 那 5 KB 入库逻辑在引擎侧，
 *      这里再收一次 = 同一份内容入库两遍（换两个 label），纯浪费。
 *      ★ 本包特有的一条：`ctx_*` 与宿主工具是不同的 MCP 服务，我们是同一个 `ctx` 壳。
 *   2. **带范围参数的读取**（`offset` / `limit` / `view_range`）—— 调用方明确要的就是那几行，
 *      给全文等于把他要的东西藏起来。
 *      ★ 2026-11-14：**按工具名限定**（`RANGE_SCOPE`）。原来全局认键，
 *        导致 `fp({op:"search", limit:N})` 也被当成"点名要范围"而跳过入库 ——
 *        而 `fp.limit` 是交付条数上限，实测能一次交付 327 KB。详见 `RANGE_SCOPE` 注释。
 *   3. **agent 自己的 instruction / skill 文件**（`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` /
 *      `QWEN.md` / `copilot-instructions.md` / `.kiro/steering/*` / `**​/skills/**` 的 .md）——
 *      这些是"规则本身"，模型必须看到原文。
 *   4. **含非文本块的结果** —— `textFromBlocks` 返回 undefined 就放行（图片/结构化块不许被改写）。
 *
 * 阈值口径（为什么 4096 而不是 5000）
 * ─────────────────────────────────────────────────────────
 *   4096 = 默认阈值，且可被 `CTX_REPLACE_TRIGGER_BYTES` 覆盖。
 *   `ctx.run` 的 5000 是维护方 2026-11-02 定案，**不动**：那条通道还有 `intent` 选块 + `full:true` 全文旁路，
 *   回执形态与这条不同。两条通道各管各的工具面，互不覆盖。
 *
 * 正文预算
 * ─────────────────────────────────────────────────────────
 *   `maxResultBytes`（默认 40 000）仍然是**总闸**：本件回给模型的东西永远 ≤ 它。
 *   历史教训（`14-tools/index.js:176-196`）：内层承诺 64 KB、外层 40 KB 先动手 = 说得出做不到。
 *   所以本件的预览 + 指路**全部计入**这个预算。
 *
 * 失败姿态
 * ─────────────────────────────────────────────────────────
 *   本监听器**永不抛**：入库失败（引擎没起来 / 库只读 / 内容为空）→ 退回 ②，并把失败原因写进文案。
 *   「入库失败就少一段内容」是禁止的（同族红线：no cut without index）。
 *
 * ★ 2026-11-03 留档：本件早期还会改写内嵌 server 的
 *   "推荐了未挂载工具"提示串（`ctx_batch_execute` / `ctx_fetch_and_index`）。
 *   1.0.0 里 vendor 只剩 LICENSE、那三个工具名一个都不存在 ⇒ 那段是空转，早已删除。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default cap before a result is spilled: ~40 KB of model-facing text. */
const DEFAULT_MAX_RESULT_BYTES = 40_000;
/** Characters kept from the head of an oversized result (fallback path only). */
const HEAD_CHARS = 6_000;
/** Characters kept from the tail of an oversized result (fallback path only). */
const TAIL_CHARS = 2_000;
/** Per-listener spill budget; the oldest files are pruned past this count. */
const MAX_SPILL_FILES = 20;

/**
 * 入库阈值（字节）。第三方 /`REPLACE_TRIGGER_BYTES = 4096`，可用同名环境变量覆盖。
 * ★ 为什么读环境变量而不是写死：这是标准做法；而且"阈值该多大"是**用户口味**，
 *   不是契约（跟 `output-containment` 的 40 KB 总闸不同，那个关乎上下文预算）。
 */
const TRIGGER_DEFAULT = 4_096;
const TRIGGER_ENV = 'CTX_REPLACE_TRIGGER_BYTES';

/** 入库通道回给模型的**头部预览**字节数（只是定位用，不是内容交付）。 */
const HEAD_PREVIEW_BYTES = 800;

/** 我们自己那个工具位的名字（它的结果不走本件入库，见文件头豁免 1）。 */
const OWN_TOOL = 'ctx';

/**
 * 带范围参数 = 调用方点名要的那几行（豁免 2）—— **按工具名限定**。
 *
 * ★ 2026-11-14 修（真漏，实测抓到）：原来是**全局**键表，
 *   于是 `fp({op:"search", query, limit:12, fullSnippet:true})` 也命中 `range:limit` 被放行。
 *   但 `fp.limit` 是**交付条数上限**，不是行号范围 ——
 *   FP 自己的 `05-outgate` 记着实测：`limit:500 + fullSnippet:true` 单次交付 **327,756 字节**。
 *   那个洞正好开在 FP 最容易爆的那条路上（给了 limit 就不入库）。
 *
 * 判据：**先认工具，再认键**。不是这三个读文件工具的调用，`limit` 一律不算范围。
 *   宁可多入一次库（能靠 14 天删线清掉），不可让一次 320 KB 整份灌进对话。
 */
const RANGE_SCOPE = Object.freeze({
    read: ['offset', 'limit', 'view_range', 'start_line', 'end_line'],
    view: ['view_range', 'start_line', 'end_line'],
    edit: ['offset', 'limit'],
});

/** 读取类工具的参数里可能出现路径的键（宿主实测：read/edit 用 file_path）。 */
const PATH_KEYS = Object.freeze(['file_path', 'absolute_path', 'filePath', 'path', 'notebook_path']);

/**
 * agent 自己的 instruction / skill 文件名（豁免 3）。
 * 这些是"规则本身"，模型必须看到原文 —— 与宿主是哪个 agent 无关，一律认。
 */
const OWN_FILES = Object.freeze([
    'agents.md', 'claude.md', 'claude.local.md', 'gemini.md', 'qwen.md',
    'copilot-instructions.md', 'readme.md', // readme：人写给人看的门户，藏着只会让人去找
]);
/** 路径里出现这些目录段 = skill / steering 目录下的文档（豁免 3）。 */
const OWN_DIR_SEGMENTS = Object.freeze(['skills', '.kiro', 'steering']);

const spilled = [];

/** 读入库阈值（坏值一律回默认，绝不因为一个环境变量把入库关掉）。 */
function readTrigger(raw) {
    if (raw === undefined || String(raw).trim() === '') return TRIGGER_DEFAULT;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : TRIGGER_DEFAULT;
}

/**
 * Install the post-execute containment listener.
 *
 * @param ctx - the plugin context whose event bus carries tool dispatch.
 * @param {object} [options]
 * @param {number} [options.maxResultBytes] 回给模型的总预算（默认 40 000）。
 * @param {string} [options.spillDir] 兜底落盘目录。
 * @param {number} [options.triggerBytes] 入库阈值（默认取 `CTX_REPLACE_TRIGGER_BYTES`，再默认 4096）。
 * @param {(args:object, signal?:AbortSignal) => Promise<any>} [options.callEngine]
 *        **惰性引擎口**：装配层给一个闭包，调用时现取 EngineClient（它可能晚于本件挂载才建好）。
 *        不给 = 只有兜底截断（等于旧行为），并在文本里如实说明"本包没接入库通道"。
 * @param {(exec:any) => string} [options.sessionIdOf] 取当前会话 id（写进 chunks.session_id）。
 * @returns the exact disposer that removes the listener.
 */
export function installOutputContainment(ctx, options = {}) {
    const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    const spillDir = options.spillDir ?? join(tmpdir(), 'dsh-eco-context-spill');
    const triggerBytes = options.triggerBytes ?? readTrigger(process.env[TRIGGER_ENV]);
    const callEngine = typeof options.callEngine === 'function' ? options.callEngine : undefined;
    const sessionIdOf = typeof options.sessionIdOf === 'function' ? options.sessionIdOf : defaultSessionId;

    return ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        // 别的监听器已经拒了/改了 → 不改写别人的决议（只处理 accept）。
        if (decision.kind !== 'accept')
            return decision;
        const source = 'content' in decision && decision.content !== undefined
            ? decision.content
            : result.content;
        const text = textFromBlocks(source);
        // 豁免 4：非纯文本（图片/混合块）→ 原样放行。
        if (text === undefined)
            return decision;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes <= triggerBytes)
            return decision;
        // 豁免 1/2/3：自己的工具 / 点名要的范围 / agent 自己的规则文件。
        // ★ 放行时**什么都不改**（连 notice 都不加）：豁免的语义是"这些东西本来就该原样给模型"，
        //   加一句"我放行了"反而是噪声。放行原因只在门里可测（`exemption()` 是导出的）。
        if (exemption(exec) !== null)
            return decision;

        // ① 入库优先
        if (callEngine !== undefined) {
            const label = toolLabel(exec);
            try {
                const out = await callEngine({
                    op: 'index',
                    content: text,
                    source: label,
                    sessionId: sessionIdOf(exec),
                });
                if (indexAccepted(out)) {
                    const replacement = [{ type: 'text', text: indexedText(exec, label, bytes, triggerBytes, text, maxResultBytes) }];
                    return { kind: 'accept', content: replacement, additionalContexts: decision.additionalContexts };
                }
                // 引擎回了 isError（例如空内容被拒）→ 落到兜底，但把原因带上
                return fallback(decision, exec, text, bytes, maxResultBytes, spillDir, `入库被引擎拒绝：${firstLine(out)}`);
            }
            catch (error) {
                return fallback(decision, exec, text, bytes, maxResultBytes, spillDir, `入库抛错：${errorMessage(error)}`);
            }
        }
        return fallback(decision, exec, text, bytes, maxResultBytes, spillDir, '本包没有接入库通道');
    });
}

/**
 * 豁免判定。返回 `null` = 不豁免（该入库）；返回字符串 = 豁免原因（只用于日志，不进模型面）。
 * @param {any} exec
 * @returns {string|null}
 */
export function exemption(exec) {
    const name = typeof exec?.name === 'string' ? exec.name : '';
    if (name === OWN_TOOL) return 'own-tool';
    const args = inputOf(exec);
    if (args === null) return null;
    // 豁免 2 只对**读文件类工具**生效（见 RANGE_SCOPE：fp/grep/run 的 limit 语义不同）。
    const rangeKeys = RANGE_SCOPE[name];
    if (rangeKeys !== undefined) {
        for (const key of rangeKeys) {
            if (args[key] !== undefined && args[key] !== null) return `range:${key}`;
        }
    }
    const p = pathOf(args);
    if (p !== undefined && isOwnFile(p)) return 'own-file';
    return null;
}

/**
 * 该工具的参数里出现这些键**不算**范围豁免 —— 导出给门做反向断言用：
 * 「fp 的 limit 必须入库」不能被后来人"顺手统一"回去。
 */
export const __RANGE_SCOPE = RANGE_SCOPE;

/** 取调用的参数对象（宿主形状容错：arguments / args / input 三档）。 */
function inputOf(exec) {
    const raw = exec?.arguments ?? exec?.args ?? exec?.input;
    if (raw === null || typeof raw !== 'object') return null;
    return raw;
}

/** 从参数里找调用方点的那个路径（只认字符串且非空）。 */
function pathOf(args) {
    for (const key of PATH_KEYS) {
        const v = args[key];
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
}

/**
 * 是不是 agent 自己的 instruction / skill 文件（豁免 3）。
 * 判据是**路径形状**，不是工具名：宿主用 read / view / edit / cat 都可能碰到它。
 */
export function isOwnFile(p) {
    const norm = String(p).split('\\').join('/').toLowerCase();
    const segs = norm.split('/');
    const base = segs[segs.length - 1] ?? '';
    if (OWN_FILES.includes(base)) return true;
    // skills / .kiro / steering 目录下的 markdown（agent 的技能与规则）
    if (!base.endsWith('.md')) return false;
    return segs.some((s, i) => i < segs.length - 1 && OWN_DIR_SEGMENTS.includes(s));
}

/** 给这次工具结果起一个独立可寻址的 source 标签（前缀 `tool:` 可族筛，与 `run:` 同族）。 */
export function toolLabel(exec) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const raw = typeof exec?.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown';
    const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'unknown';
    return `tool:${safe}:${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/** 引擎回执是否算"入库成功"（MCP 形状 `{content:[{type:'text',text}], isError?}`）。 */
function indexAccepted(out) {
    if (out === null || typeof out !== 'object') return false;
    if (out.isError === true) return false;
    const blocks = Array.isArray(out.content) ? out.content : [];
    const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    // 引擎成功文案是「已写入 <label>：N 块…」；失败文案以 ERROR 码开头。
    return /已写入/.test(text);
}

/** 入库成功的回执：source 标签 + 两条取回指路 + 一小段头部预览（全部计入 40 KB 预算）。 */
function indexedText(exec, label, bytes, triggerBytes, text, maxResultBytes) {
    const kb = (bytes / 1024).toFixed(1);
    const tkb = (triggerBytes / 1024).toFixed(1);
    const head = capUtf8(text, Math.min(HEAD_PREVIEW_BYTES, Math.max(0, maxResultBytes - 1024)));
    const lines = [
        `[dsh-eco-context] ${toolName(exec)} 输出 ${kb} KB > ${tkb} KB：**已整份入库**，正文不进对话。`,
        '',
        `取回片段：ctx({op:"recall",queries:[具体词],source:"${label}"})`,
        `取回全文：同一条加 full:true（最多 40KB；再多就去读文件）`,
        `也按查询词搜：ctx({op:"recall",queries:[具体词]})（不带 source 时全库搜）`,
    ];
    if (head.length > 0) {
        lines.push('', `--- 前 ${Buffer.byteLength(head, 'utf8')} B 预览（只为定位，完整内容在库里）---`, head);
    }
    return lines.join('\n');
}

/**
 * 兜底：入库不可用时退回旧行为（头 + 尾 + spill 落盘），并**如实说明为什么是截断**。
 * 这条路径的存在意义：`no cut without index` 的反面 —— 库不可用也不能让内容凭空消失，
 * 至少要落一份文件在盘上并告诉模型去哪读。
 */
function fallback(decision, exec, text, bytes, maxResultBytes, spillDir, reason) {
    const record = spill(text, spillDir, exec);
    const replacement = [{ type: 'text', text: summarize(exec, text, record, maxResultBytes, reason) }];
    return { kind: 'accept', content: replacement, additionalContexts: decision.additionalContexts };
}

/** Concatenate text blocks, or return undefined when the result is not plain text. */
function textFromBlocks(content) {
    if (!Array.isArray(content)) return undefined;
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string')
            return undefined;
        parts.push(block.text);
    }
    return parts.length === 0 ? undefined : parts.join('\n');
}

/** Persist one oversized payload and return its locator. */
function spill(text, spillDir, exec) {
    const path = join(spillDir, `${sanitize(toolName(exec))}-${Date.now().toString(36)}.txt`);
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
        mkdirSync(spillDir, { recursive: true });
        writeFileSync(path, text, 'utf8');
        spilled.push({ path, bytes });
        while (spilled.length > MAX_SPILL_FILES)
            spilled.shift();
        return { path, bytes };
    }
    catch {
        // A missing spill directory must not fail the tool call; the caller gets a
        // truncated result without a locator.
        return { path: '', bytes };
    }
}

/** Build the model-facing replacement: head, tail, and a read-back instruction. */
function summarize(exec, text, record, maxResultBytes, reason) {
    const head = text.slice(0, HEAD_CHARS);
    const tail = text.slice(-TAIL_CHARS);
    const omitted = text.length - head.length - tail.length;
    const lines = [
        `[dsh-eco-context] ${toolName(exec)} 输出 ${record.bytes} B（上限 ${maxResultBytes}）；`
            + `中间 ${omitted} 字符被截断 —— **原因是没进成库**：${reason}。`,
    ];
    if (record.path.length > 0) {
        lines.push(`全文已落盘：${record.path}`);
        // 2026-11-04：旧文案引导模型调 ctx_execute_file / ctx_index / ctx_search ——
        //   这三个名字在 1.0.0 工具面上都不存在，照做只会每次白报错。换成 op 形状。
        lines.push('读它：ctx({op:"run", language:"javascript", code:…读该路径…})；或 ctx({op:"index", path:"…"}) 之后再 ctx({op:"recall", queries:[…]})。别把它整份再打进对话。');
    }
    else {
        lines.push('落盘也失败了（目录不可写）：下次用 ctx({op:"run"}) 让原始输出不进对话。');
    }
    lines.push('', '--- head ---', head, '', '--- tail ---', tail);
    return lines.join('\n');
}

/** 按 UTF-8 字节截断，不劈多字节字符。 */
function capUtf8(text, maxBytes) {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let out = '';
    let used = 0;
    for (const ch of text) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (used + b > maxBytes) break;
        out += ch;
        used += b;
    }
    return out;
}

/** Keep a tool name safe for a filename. */
function sanitize(name) {
    return String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'tool';
}

/** 工具名（日志与文案用；缺了给 unknown，别渲染出 undefined）。 */
function toolName(exec) {
    return typeof exec?.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown';
}

/** 默认会话 id 取法（宿主形状：exec.session.id / exec.agent.session.id）。 */
function defaultSessionId(exec) {
    const s = exec?.session ?? exec?.agent?.session;
    return s !== undefined && typeof s.id === 'string' ? s.id : '';
}

/** 取 MCP 回执里的第一行文本（失败原因摘要用）。 */
function firstLine(out) {
    const blocks = Array.isArray(out?.content) ? out.content : [];
    const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n').trim();
    if (text === '') return '无回执';
    return text.split('\n')[0].slice(0, 200);
}

/** @param {unknown} error */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/** Test-only: expose recorded spills for assertions. */
export function __spillRecordsForTests() {
    return spilled;
}

/** Test-only: the trigger default (门要对拍这个数，不许在门里再写一个字面量)。 */
export const __TRIGGER_DEFAULT = TRIGGER_DEFAULT;
