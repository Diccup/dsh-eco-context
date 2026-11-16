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
 * 05-analyze — 读进来先看懂
 *
 * 干什么：把一段原文切成分块（markdown 标题栈 / 纯文本按行 / JSON key path），
 *        并做 NFKC 归一。切块质量直接决定检索质量，所以这块单独成积木、可单测。
 * 为什么这样：1.2.2 把切块塞在 store.js 的 L1320-1713 里（跟 SQL 混在一坨），
 *            比不出高低也改不动；这里抽出来，插槽 17-plugs/chunk/* 可以换实现。
 * 边界：**只做字符串到 chunk[] 的纯函数**，不碰库、不碰文件 IO（读文件归 02-project/08-writer）。
 *       分块结果形状固定 {title, content, hasCode}，谁都不许多加字段。
 */

import { err } from '../../libs/err.js';

export const NAME = 'analyze';
export const INVARIANTS = [
    '纯函数：同样的输入永远同样的输出，不读文件、不连库',
    '任何 chunk 的 UTF-8 字节数 ≤ maxChunkBytes（超了必须拆）',
    '切块不切断代码块围栏（``` 之内不许被拆）',
];

const MAX_CHUNK_BYTES = 4096;
const CHUNK_TITLE_MAX_CHARS = 80;
const MIN_BLANK_LINE_SECTIONS = 3;
const MAX_BLANK_LINE_SECTIONS = 200;
const BLANK_SECTION_STRATEGY_MAX_BYTES = 5000;
const WHITESPACE_BREAK_RATIO = 0.5;

/**
 * 清洗入库原文：只去 BOM + NUL，**不做 NFKC**。
 *
 * ★ 2026-11-05 实测：NFKC 把全角标点压成半角（：→: ，→, １→1 …→...），
 *   写进库的是**被改写过的原文**。后果有两个，都是真的：
 *     ① 中文文档存档失真，recall 出来的已经不是原文件内容；
 *     ② 拿 recall 的片段当 edit 的 old_string，标点对不上 → FS_EDIT_NOT_FOUND，
 *        还会被误判成"文件被别人改过"。
 *   NFKC 的正当用途是**检索归一**（全角/半角搜得到同一份），那属于索引侧。
 *   所以这里分家：normalize() = 存原文；foldForSearch() = 检索用。
 */
export function normalize(text) {
    if (typeof text !== 'string') return '';
    /* eslint-disable-next-line no-control-regex */
    return text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/**
 * 检索归一：NFKC + 小写 + 折叠汉字间空白。**只喂索引和查询，绝不写进 content 列。**
 * 全角标点在这里被压成半角，于是"ＡＢＣ"和"ABC"、"："和":"搜得同一份 —— 这才是 NFKC 该待的地方。
 */
export function foldForSearch(text) {
    if (typeof text !== 'string') return '';
    return normalize(text).normalize('NFKC');
}

/** 按码点取字节上限内的前缀（不劈 CJK / emoji）。 */
export function byteCappedPrefix(str, maxBytes) {
    if (Buffer.byteLength(str) <= maxBytes) return str;
    let prefix = '';
    let bytes = 0;
    for (const ch of str) {
        const b = Buffer.byteLength(ch);
        if (bytes + b > maxBytes) break;
        prefix += ch;
        bytes += b;
    }
    if (prefix.length === 0) return [...str][0] ?? '';
    return prefix;
}

/** markdown 分块：标题栈成面包屑，代码块整块不拆，超限按段落二次切。 */
export function chunkMarkdown(text, maxChunkBytes = MAX_CHUNK_BYTES) {
    const chunks = [];
    const lines = normalize(text).split('\n');
    const headingStack = [];
    let currentContent = [];
    let currentHeading = '';

    const buildTitle = () => {
        if (headingStack.length === 0) return currentHeading || 'Untitled';
        return headingStack.map((h) => h.text).join(' > ');
    };

    const flush = () => {
        const joined = currentContent.join('\n').trim();
        if (joined.length === 0) return;
        const title = buildTitle();
        const hasCode = currentContent.some((l) => /^`{3,}/.test(l));
        if (Buffer.byteLength(joined) <= maxChunkBytes) {
            chunks.push({ title, content: joined, hasCode });
            currentContent = [];
            return;
        }
        // 超限：按双换行切段，逐段累加
        const paragraphs = joined.split(/\n\n+/);
        let acc = [];
        let partIndex = 1;
        const flushAcc = () => {
            if (acc.length === 0) return;
            const part = acc.join('\n\n').trim();
            if (part.length === 0) return;
            const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
            partIndex++;
            chunks.push({ title: partTitle, content: part, hasCode: part.includes('```') });
            acc = [];
        };
        for (const para of paragraphs) {
            // ★ 单段自身就超限（整段没有双换行，例如一份长日志）→ 必须按行/按字节二次切，
            //    否则会吐出一个 8KB 的块（T-7 实测抓到：块超限 8507 > 4096）。
            if (Buffer.byteLength(para) > maxChunkBytes) {
                flushAcc();
                chunks.push(...splitOversizedPlainChunk(para.split('\n'), title, maxChunkBytes));
                continue;
            }
            acc.push(para);
            if (Buffer.byteLength(acc.join('\n\n')) > maxChunkBytes && acc.length > 1) {
                acc.pop();
                flushAcc();
                acc = [para];
            }
        }
        flushAcc();
        currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^[-_*]{3,}\s*$/.test(line)) { flush(); i++; continue; }
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
            flush();
            const level = heading[1].length;
            const text0 = heading[2].trim();
            while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
            headingStack.push({ level, text: text0 });
            currentHeading = text0;
            currentContent.push(line);
            i++;
            continue;
        }
        const fenceMatch = line.match(/^(`{3,})(.*)?$/);
        if (fenceMatch) {
            const fence = fenceMatch[1];
            const codeLines = [line];
            i++;
            while (i < lines.length) {
                codeLines.push(lines[i]);
                if (lines[i].startsWith(fence) && lines[i].trim() === fence) { i++; break; }
                i++;
            }
            currentContent.push(...codeLines);
            continue;
        }
        currentContent.push(line);
        i++;
    }
    flush();
    return chunks;
}

/** 单条超限纯文本的二次切（按行累加，超长单行按字节+空白断点切）。 */
function splitOversizedPlainChunk(lines, titlePrefix, maxChunkBytes) {
    const out = [];
    let acc = [];
    let partIndex = 1;
    const flushAcc = () => {
        if (acc.length === 0) return;
        const partTitle = partIndex === 1 ? titlePrefix : `${titlePrefix} (${partIndex})`;
        out.push({ title: partTitle, content: acc.join('\n'), hasCode: false });
        partIndex++;
        acc = [];
    };
    for (const line of lines) {
        if (Buffer.byteLength(line) > maxChunkBytes) {
            flushAcc();
            let rest = line;
            let linePart = 1;
            while (rest.length > 0) {
                let slice = byteCappedPrefix(rest, maxChunkBytes);
                if (slice.length < rest.length) {
                    const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
                    if (cut > slice.length * WHITESPACE_BREAK_RATIO) slice = slice.slice(0, cut);
                }
                const t = partIndex === 1 && linePart === 1 ? titlePrefix : `${titlePrefix} (${partIndex}.${linePart})`;
                out.push({ title: t, content: slice, hasCode: false });
                rest = rest.slice(slice.length);
                linePart++;
                partIndex++;
            }
            continue;
        }
        const candidate = acc.length > 0 ? acc.join('\n') + '\n' + line : line;
        if (Buffer.byteLength(candidate) > maxChunkBytes && acc.length > 0) flushAcc();
        acc.push(line);
    }
    flushAcc();
    return out;
}

/** 纯文本分块（日志/构建输出/测试结果）：先试空行分节，不行按行组。 */
export function chunkPlainText(text, linesPerChunk = 20, maxChunkBytes = MAX_CHUNK_BYTES) {
    const src = normalize(text);
    const sections = src.split(/\n\s*\n/);
    if (sections.length >= MIN_BLANK_LINE_SECTIONS && sections.length <= MAX_BLANK_LINE_SECTIONS &&
        sections.every((s) => Buffer.byteLength(s) < BLANK_SECTION_STRATEGY_MAX_BYTES)) {
        return sections.flatMap((section, i) => {
            const trimmed = section.trim();
            if (trimmed.length === 0) return [];
            const title = trimmed.split('\n')[0].slice(0, CHUNK_TITLE_MAX_CHARS) || `Section ${i + 1}`;
            if (Buffer.byteLength(trimmed) <= maxChunkBytes) return [{ title, content: trimmed, hasCode: false }];
            return splitOversizedPlainChunk(trimmed.split('\n'), title, maxChunkBytes);
        });
    }
    const lines = src.split('\n');
    if (lines.length <= linesPerChunk) {
        if (Buffer.byteLength(src) <= maxChunkBytes) return [{ title: 'Output', content: src, hasCode: false }];
        return splitOversizedPlainChunk(lines, 'Output', maxChunkBytes);
    }
    const chunks = [];
    const overlap = 2;
    const step = Math.max(linesPerChunk - overlap, 1);
    for (let i = 0; i < lines.length; i += step) {
        const slice = lines.slice(i, i + linesPerChunk);
        if (slice.length === 0) break;
        const startLine = i + 1;
        const endLine = Math.min(i + slice.length, lines.length);
        const label = slice[0]?.trim().slice(0, CHUNK_TITLE_MAX_CHARS) || `Lines ${startLine}-${endLine}`;
        const joined = slice.join('\n');
        if (Buffer.byteLength(joined) <= maxChunkBytes) chunks.push({ title: label, content: joined, hasCode: false });
        else chunks.push(...splitOversizedPlainChunk(slice, label, maxChunkBytes));
    }
    return chunks;
}

/** JSON 分块：key path 当标题，数组按体积批处理。 */
export function chunkJSON(content, maxChunkBytes = MAX_CHUNK_BYTES) {
    let parsed;
    try { parsed = JSON.parse(content); } catch { return chunkPlainText(content, 20, maxChunkBytes); }
    const chunks = [];
    walkJSON(parsed, [], chunks, maxChunkBytes);
    return chunks.length > 0 ? chunks : chunkPlainText(content, 20, maxChunkBytes);
}

function findIdentityField(arr) {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
    for (const f of ['id', 'name', 'title', 'path', 'slug', 'key', 'label']) {
        if (f in first && (typeof first[f] === 'string' || typeof first[f] === 'number')) return f;
    }
    return null;
}

function jsonBatchTitle(prefix, startIdx, endIdx, batch, idField) {
    const sep = prefix ? `${prefix} > ` : '';
    if (!idField) return startIdx === endIdx ? `${sep}[${startIdx}]` : `${sep}[${startIdx}-${endIdx}]`;
    const gid = (it) => String(it[idField]);
    if (batch.length === 1) return `${sep}${gid(batch[0])}`;
    if (batch.length <= 3) return sep + batch.map(gid).join(', ');
    return `${sep}${gid(batch[0])}\u2026${gid(batch[batch.length - 1])}`;
}

function chunkJSONArray(arr, p, chunks, maxChunkBytes) {
    const prefix = p.length > 0 ? p.join(' > ') : '(root)';
    const idField = findIdentityField(arr);
    let batch = [];
    let batchStart = 0;
    const flushBatch = (batchEnd) => {
        if (batch.length === 0) return;
        chunks.push({
            title: jsonBatchTitle(prefix, batchStart, batchEnd, batch, idField),
            content: JSON.stringify(batch, null, 2),
            hasCode: true,
        });
    };
    for (let i = 0; i < arr.length; i++) {
        batch.push(arr[i]);
        if (Buffer.byteLength(JSON.stringify(batch, null, 2)) > maxChunkBytes && batch.length > 1) {
            batch.pop();
            flushBatch(i - 1);
            batch = [arr[i]];
            batchStart = i;
        }
    }
    flushBatch(batchStart + batch.length - 1);
}

function walkJSON(value, p, chunks, maxChunkBytes) {
    const title = p.length > 0 ? p.join(' > ') : '(root)';
    const serialized = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(serialized) <= maxChunkBytes) {
        const shouldRecurse = typeof value === 'object' && value !== null && !Array.isArray(value) &&
            Object.values(value).some((v) => typeof v === 'object' && v !== null);
        if (!shouldRecurse) { chunks.push({ title, content: serialized, hasCode: true }); return; }
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length > 0) {
            for (const [k, v] of entries) walkJSON(v, [...p, k], chunks, maxChunkBytes);
            return;
        }
        chunks.push({ title, content: serialized, hasCode: true });
        return;
    }
    if (Array.isArray(value)) { chunkJSONArray(value, p, chunks, maxChunkBytes); return; }
    chunks.push({ title, content: serialized, hasCode: typeof value === 'string' });
}

/** 统一入口：按 kind 选分块器（插槽化，17-plugs/chunk/* 可替换）。 */
export function chunk(text, kind = 'markdown', opts = {}) {
    const max = opts.maxChunkBytes ?? MAX_CHUNK_BYTES;
    let out;
    if (kind === 'json') out = chunkJSON(text, max);
    else if (kind === 'plain') out = chunkPlainText(text, opts.linesPerChunk ?? 20, max);
    else out = chunkMarkdown(text, max);
    if (out.length === 0 && text && text.trim().length > 0) {
        // 保证"有内容就至少一块"，否则写入会静默 0 块
        out = [{ title: 'Untitled', content: normalize(text).trim(), hasCode: false }];
    }
    return out;
}

/** 不变量自检：任何 chunk 不超限、不含空块。 */
export function assertChunks(chunks, maxChunkBytes = MAX_CHUNK_BYTES) {
    for (const c of chunks) {
        if (!c || typeof c.title !== 'string' || typeof c.content !== 'string') throw err('NO_INPUT', { chunk: c });
        if (c.content.trim().length === 0) throw new Error('05-analyze: 产出空块');
        if (Buffer.byteLength(c.content) > maxChunkBytes) throw new Error(`05-analyze: 块超限 ${Buffer.byteLength(c.content)} > ${maxChunkBytes}`);
    }
    return true;
}

export function init() { /* 纯函数块，无需初始化 */ }
