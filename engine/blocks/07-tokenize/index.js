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
 * 07-tokenize — 英文/子串分词与表达式
 *
 * 干什么：porter 词表达式、trigram 子串表达式、88 词停用词表、短语相邻性保真。
 * 为什么这样：1.2.2 的 sanitizeQuery 把短语降级成 OR —— 这是 CJK 塌陷的病灶之一
 *            （01-立项书 §六 裁决④、02-清单 §4.5）。这里**短语模式保留相邻性**：
 *            用户写 "foo bar" 就该按序匹配，不是"两个词随便出现都算"。
 * 边界：纯函数；不出 SQL 全文（只出 MATCH 表达式片段），表名/列名由 09-reader 传。
 */

export const NAME = 'tokenize';
export const INVARIANTS = [
    '短语（带引号）保留相邻性，不做 OR 降级',
    'trigram 表达式过滤 <3 字符的词（trigram 天然做不到）',
    '停用词只在排序降权时考虑，绝不从 AND 条件里删干净（全停用词查询要回退）',
];

/** 88 词停用词表（原样搬 1.2.2 store.js L20-34，别增删 —— 它已经过实测校准）。 */
export const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may',
    'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'got', 'let',
    'say', 'she', 'too', 'use', 'will', 'with', 'this', 'that', 'from',
    'they', 'been', 'have', 'many', 'some', 'them', 'than', 'each', 'make',
    'like', 'just', 'over', 'such', 'take', 'into', 'year', 'your', 'good',
    'could', 'would', 'about', 'which', 'their', 'there', 'other', 'after',
    'should', 'through', 'also', 'more', 'most', 'only', 'very', 'when',
    'what', 'then', 'these', 'those', 'being', 'does', 'done', 'both',
    'same', 'still', 'while', 'where', 'here', 'were', 'much',
    // 代码/changelog 里高频
    'update', 'updates', 'updated', 'deps', 'dev', 'tests', 'test',
    'add', 'added', 'fix', 'fixed', 'run', 'running', 'using',
]);

/** FTS5 保留字，直接丢掉（用户写 AND 当普通词会被当操作符）。 */
const BOOLEAN_OPS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/** 大小写无关去重，保留首次出现的大小写。 */
export function dedupeTokens(tokens) {
    const seen = new Set();
    const out = [];
    for (const t of tokens) {
        const k = t.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
    return out;
}

/**
 * 短语检测：`"foo bar"` 或 `'foo bar'` → 一个短语单元，**保留相邻性语义**。
 * 返回 [{kind:'phrase', value}, {kind:'term', value}]。
 */
export function parseUnits(query) {
    const units = [];
    const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
    let m;
    while ((m = re.exec(String(query))) !== null) {
        const phrase = m[1] ?? m[2];
        const term = m[3];
        if (phrase !== undefined) {
            const words = phrase.trim().split(/\s+/).filter(Boolean);
            if (words.length > 0) units.push({ kind: 'phrase', value: words });
        }
        else if (term) {
            if (!BOOLEAN_OPS.has(term.toUpperCase())) units.push({ kind: 'term', value: term });
        }
    }
    return units;
}

/**
 * porter 词表达式。
 * @param {string} query 原始查询
 * @param {'AND'|'OR'} mode 非短语单元之间的连接方式
 */
export function porterExpr(query, mode = 'AND') {
    const cleaned = String(query).replace(/[(){}[\]*:^~]/g, ' ');
    const units = parseUnits(cleaned);
    if (units.length === 0) return '""';
    const cleaned2 = units.map((u) => {
        if (u.kind === 'phrase') {
            // ★ 短语保留相邻：整段加引号，FTS5 按序匹配
            return { kind: 'phrase', words: dedupeTokens(u.value) };
        }
        return { kind: 'term', words: [u.value] };
    });
    const allTerms = cleaned2.flatMap((u) => u.words);
    const meaningful = allTerms.filter((w) => !STOPWORDS.has(w.toLowerCase()));
    const keepStopwords = meaningful.length === 0; // 全停用词 → 不过滤，否则啥都不剩
    const joiner = mode === 'OR' ? ' OR ' : ' ';
    const parts = [];
    for (const u of cleaned2) {
        const words = keepStopwords ? u.words : u.words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
        if (words.length === 0) continue;
        if (u.kind === 'phrase' && words.length > 1) {
            parts.push(`"${words.map(esc).join(' ')}"`); // 相邻短语
        }
        else {
            parts.push(...words.map((w) => `"${esc(w)}"`));
        }
    }
    if (parts.length === 0) return '""';
    return parts.join(joiner);
}

function esc(s) { return String(s).replace(/"/g, '""'); }

/** trigram 表达式：过滤 <3 字符、非 ASCII 通配；短语同样保序。 */
export function trigramExpr(query, mode = 'AND') {
    // 保留引号交给 parseUnits（短语相邻性靠它）；只清 FTS 语法字符
    const cleaned = String(query).replace(/[(){}[\]*:^~]/g, '').trim();
    if (cleaned.replace(/["']/g, '').trim().length < 3) return '';
    const units = parseUnits(cleaned);
    const words = [];
    for (const u of units) {
        if (u.kind === 'phrase') words.push({ phrase: true, value: u.value.filter((w) => w.length >= 3) });
        else if (u.value.length >= 3) words.push({ phrase: false, value: [u.value] });
    }
    const flat = words.flatMap((w) => w.value);
    if (flat.length === 0) return '';
    const meaningful = flat.filter((w) => !STOPWORDS.has(w.toLowerCase()));
    const keep = meaningful.length > 0;
    const joiner = mode === 'OR' ? ' OR ' : ' ';
    const parts = [];
    for (const w of words) {
        const v = keep ? w.value.filter((x) => !STOPWORDS.has(x.toLowerCase())) : w.value;
        if (v.length === 0) continue;
        if (w.phrase && v.length > 1) parts.push(`"${v.map(esc).join(' ')}"`);
        else parts.push(...v.map((x) => `"${esc(x)}"`));
    }
    return parts.join(joiner);
}

/**
 * ★ 原生 FTS5 表达式（**整串交后端解析器**，Q-2 的"含引号/显式 AND OR NOT → 不拆"）。
 *
 * 为什么必须整串交：
 *   拆词后加引号会把 `"WAL" AND "checkpoint"` 变成 `(title: ("WAL" "AND" "checkpoint") OR …)`，
 *   那是**三个词都出现**的 AND 语义 → 命中 0；原生 `"WAL" AND "checkpoint"` → 命中 28。
 *   布尔是用户显式写的语义，拆掉就是撒谎。
 *
 * 本函数把原始查询**保结构**地重组成一个**语法一定合法**的 FTS5 表达式：
 *   · 引号段 → 整段作为一个短语（内部双引号按 FTS5 规则转义成两个）
 *   · 裸词 AND/OR/NOT/NEAR → 保留为运算符（这是用户显式的布尔）
 *   · 其余裸词 → 加引号当短语（避免 `*` `:` `^` `-` 等把 FTS5 语法搞炸）
 *
 * @param {string} query 原始查询
 * @returns {string|null} 表达式；空查询返回 null
 */
export function nativeExpr(query) {
    const s = String(query ?? '').trim();
    if (s.length === 0) return null;
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const dq = m[1];
        const sq = m[2];
        const bare = m[3];
        if (dq !== undefined) {
            const body = dq.trim();
            if (body.length > 0) out.push(`"${body.replace(/"/g, '""')}"`);
            continue;
        }
        if (sq !== undefined) {
            const body = sq.trim();
            if (body.length > 0) out.push(`"${body.replace(/"/g, '""')}"`);
            continue;
        }
        if (/^(AND|OR|NOT|NEAR)$/i.test(bare)) {
            out.push(bare.toUpperCase());
            continue;
        }
        out.push(`"${bare.replace(/"/g, '""')}"`);
    }
    return out.length > 0 ? out.join(' ') : null;
}

/**
 * 查询里有没有**显式布尔**（含引号也算 —— 引号内的短语也是原生语义）。
 * @param {string} query
 */
export function hasBooleanSyntax(query) {
    const s = String(query ?? '');
    if (s.includes('"') || s.includes("'")) return true;
    const padded = ` ${s} `;
    return [' AND ', ' OR ', ' NOT ', ' NEAR '].some((op) => padded.includes(op));
}

/** 排序降权用的词（去停用词 + 长度 ≥2），不用于过滤查询。 */
export function rankTerms(query) {
    const all = String(query).toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    const filtered = all.filter((w) => !STOPWORDS.has(w));
    return filtered.length > 0 ? filtered : all;
}

/** 模糊纠错候选词（只取长度 ≥3 且非停用词）。 */
export function fuzzyWords(query) {
    return String(query).toLowerCase().trim().split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** 编辑距离（fuzzy 二段用）。 */
export function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        for (let j = 1; j <= b.length; j++) {
            curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        prev = curr;
    }
    return prev[b.length];
}

export function maxEditDistance(len) {
    if (len <= 4) return 1;
    if (len <= 12) return 2;
    return 3;
}

export function init() { /* 纯函数块 */ }
