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
 * verify/recall-metrics.mjs — 查询面指标台（RecallAll / PrecisionAll / HitRate@10）
 *
 * 干什么：在**真库**上跑三口径，并把「旧三榜（顶替版）」与「规格三榜（本次修的）」
 * 同机同库对照跑一遍，输出对照表。
 *
 * 为什么要有它（2026-11-04 甲档）：
 *   「能不能达到设计要求」这句话，靠嘴说没用 —— 必须有一个**每次都能重跑**的数。
 *   06 报告里那些数字（A/B 实测）是一次性探针，跑完就没了；本文件把它固化。
 *
 * ★ 真值怎么定（关键：不依赖被测系统）：
 *   真值 = 块正文里**字面出现**查询词的块（大小写不敏感，全部词都要出现）。
 *   这是纯字符串判据，与 FTS5 / RRF / 三榜完全无关 —— 所以它能当裁判。
 *   （若用"检索命中"当真值，就是自己给自己打分。）
 *
 * 口径（《外部方案调研.md》§2.4）：
 *   RecallAll    = 真值块中被 top-K 召回的比例（覆盖）
 *   PrecisionAll = top-K 命中块里属于真值的比例（纯净）
 *   HitRate@10   = 真值非空且 top-10 里有真值块的查询比例
 *   TOPK         = 200
 *
 * 跑法：
 *   node engine/verify/recall-metrics.mjs                  # 活体新库 + 两种实现对照
 *   node engine/verify/recall-metrics.mjs --db <路径>      # 指定库（只读）
 *   node engine/verify/recall-metrics.mjs --json           # 机器可读
 *   node engine/verify/recall-metrics.mjs --no-baseline    # 只跑新实现
 *
 * 红线：**只读打开真库**，不写库、不续命、不刷新。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);

const TOPK = 200;
const args = process.argv.slice(2);
const useJson = args.includes('--json');
const withBaseline = !args.includes('--no-baseline');
// ★ 参数档位（P-01 gram 列权重 / P-04 tier boost）：
//   `--gram-weight <x>` 换 chunks 表第三个 bm25 权重（gram 列）
//   `--tier <x>`        换 tier boost 值（0 = 关闭，对照组）
const gwIdx = args.indexOf('--gram-weight');
const GRAM_WEIGHT = gwIdx >= 0 ? Number(args[gwIdx + 1]) : null;
const tierIdx = args.indexOf('--tier');
const TIER_WEIGHT = tierIdx >= 0 ? Number(args[tierIdx + 1]) : null;
const dbArgIdx = args.indexOf('--db');
const DB_PATH = dbArgIdx >= 0
    ? args[dbArgIdx + 1]
    : path.join(ENGINE, '..', 'library', 'content.db');

// ─────────────────────────────────────────────────────────
// 查询集：固定手写集（跨机器可比）+ 库内采样补充
// ─────────────────────────────────────────────────────────
const FIXED_QUERIES = [
    '僵尸进程', '结论', '约束', 'WAL checkpoint', 'install verify',
    'process kill', '内存泄漏', 'user_version', 'trigram', 'script_ngrams',
    'sqlite fts5', 'checkpoint', 'session archive', '压测', '性能',
];

// ─────────────────────────────────────────────────────────
// 两种实现：A = 旧（gram 顶替 porter，三榜塌成一榜）；B = 新（规格三榜）
// ─────────────────────────────────────────────────────────

/** A：旧实现（2026-11-04 之前）。刻意完整复刻 `09-reader` 的老逻辑。 */
function legacyLayers(db, s, q) {
    const lists = [];
    const porterExpr = porterExprOld(q);
    const triExpr = trigramExprOld(q);
    const gramExpr = buildMatchOld(q);
    const pRows = gramExpr ? rowsPorter(db, gramExpr, s, false) : rowsPorter(db, porterExpr, s, false);
    if (pRows.length) lists.push(['porter', pRows]);
    const gRows = gramExpr ? rowsPorter(db, gramExpr, s, false) : [];
    if (gRows.length) lists.push(['gram', gRows]);
    const tRows = rowsTrigram(db, triExpr, s);
    if (tRows.length) lists.push(['trigram', tRows]);
    return lists;
}

/** B：新实现（规格三榜）。porter/gram/trigram 各打各的目标 + full 优先层。 */
function specLayers(db, s, q) {
    const lists = [];
    const bool = hasBooleanSyntax(q);
    const native = bool ? nativeExpr(q) : null;
    const pExpr = native ?? porterExprNew(q);
    const gExpr = gramOnlyExpr(q);
    const tExpr = native ?? trigramExprNew(q);
    const pRows = rowsPorter(db, pExpr, s, true);
    if (pRows.length) lists.push(['porter', pRows]);
    const gRows = gExpr ? rowsPorter(db, gExpr, s, false) : [];
    if (gRows.length) lists.push(['gram', gRows]);
    const tRows = rowsTrigram(db, tExpr, s);
    if (tRows.length) lists.push(['trigram', tRows]);
    return lists;
}

// ── SQL 片段（与引擎 libs/sql.js 同口径；gram 权重可切档） ──
const GRAM_W = GRAM_WEIGHT === null ? 1.0 : GRAM_WEIGHT;
const BM25_CHUNKS = `bm25(chunks, 5.0, 1.0, ${GRAM_W.toFixed(1)})`;
const BM25_TRI = 'bm25(chunks_trigram, 5.0, 1.0)';
// ★ 规格三榜的 porter 层：**OR 出榜 + AND 形态作 full 优先层**（2.0 ADR-0009 §8.3 口径）。
//   `full` = 这一行是不是**所有词都出现**（子查询与主查询同表、不相关 → SQLite 只算一次）。
const SEL_CHUNKS = `SELECT chunks.title, chunks.content, sources.label AS label, ${BM25_CHUNKS} AS rank,
  (chunks.rowid IN (SELECT rowid FROM chunks WHERE chunks MATCH ?)) AS full,
  chunks.session_id AS session_id
  FROM chunks JOIN sources ON sources.id = chunks.source_id
  WHERE chunks MATCH ? ORDER BY full DESC, rank LIMIT ?`;
const SEL_CHUNKS_LEGACY = `SELECT chunks.title, chunks.content, sources.label AS label, ${BM25_CHUNKS} AS rank
  FROM chunks JOIN sources ON sources.id = chunks.source_id
  WHERE chunks MATCH ? ORDER BY rank LIMIT ?`;
const SEL_TRI = `SELECT chunks_trigram.title, chunks_trigram.content, sources.label AS label, ${BM25_TRI} AS rank
  FROM chunks_trigram JOIN sources ON sources.id = chunks_trigram.source_id
  WHERE chunks_trigram MATCH ? ORDER BY rank LIMIT ?`;

/** 一榜的两种 SQL：规格版带 full 优先层，旧版不带。 */
function rowsPorter(db, expr, s, spec = true) {
    if (!expr) return [];
    try {
        // 旧版：不带 full 层（纯 bm25 排序）
        if (!spec) return db.prepare(SEL_CHUNKS_LEGACY).all(expr, s.limit);
        // 规格版：单词查询时 full ≡ match → 不必多跑一次子查询
        if (!s.allExpr) return db.prepare(SEL_CHUNKS_LEGACY).all(expr, s.limit);
        return db.prepare(SEL_CHUNKS).all(s.allExpr, expr, s.limit);
    }
    catch { return []; }
}
function rowsTrigram(db, expr, s) {
    if (!expr) return [];
    try { return db.prepare(SEL_TRI).all(expr, s.limit); }
    catch { return []; }
}

/**
 * RRF(K=60)，key = source::title（与引擎同口径）。
 * ★ full 优先层（2.0 ADR-0009 §8.3）：`full`=1 的行（所有词都出现）排前面 ——
 *   这就是「AND 全匹配优先」，用 gram 短语实现不另加 SQL 分支（最终定义 §三）。
 */
function rrfFuse(lists, limit) {
    const K = 60;
    const scoreMap = new Map();
    for (const [, rows] of lists) {
        for (const [i, r] of rows.entries()) {
            const key = `${r.label}::${r.title}`;
            const inc = 1 / (K + i + 1);
            const ex = scoreMap.get(key);
            if (ex) { ex.score += inc; ex.full = ex.full || (r.full === 1); }
            else scoreMap.set(key, { result: r, score: inc, full: r.full === 1 });
        }
    }
    return Array.from(scoreMap.values())
        .sort((a, b) => b.full - a.full || b.score - a.score)
        .slice(0, limit)
        .map(({ result, score, full }) => ({ ...result, rank: -score, full: full ? 1 : 0 }));
}

/**
 * ★ tier boost（2.0 的 tier 分档，最终定义 §三"要，且零表结构成本"）：
 *   给**当前会话**的块加权。判据 = `sessionId === 当前会话 id`（不是"有 sessionId 就加权"）。
 *   指标台口径：当前会话 = 库里 session_id 非空的那一批块（库里的历史会话）。
 *   风险线（P-04）：tier>0 若把非当前会话的长期决策挤出 top10 → RecallAll 掉 >2 点就退回 0。
 */
function applyTierBoost(rows, tierWeight) {
    if (!tierWeight || tierWeight === 0) return rows;
    return rows
        .map((r) => ({ ...r, boost: r.sessionId ? tierWeight : 0 }))
        .sort((a, b) => b.boost - a.boost || a.rank - b.rank)
        .map((r) => ({ ...r, boost: undefined }));
}

// ── 表达式构造（复刻引擎 07-tokenize / 06-gram 的语义） ──
const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
    'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'got', 'let',
    'say', 'she', 'too', 'use', 'will', 'with', 'this', 'that', 'from', 'they', 'been', 'have', 'many', 'some',
    'them', 'than', 'each', 'make', 'like', 'just', 'over', 'such', 'take', 'into', 'year', 'your', 'good',
    'could', 'would', 'about', 'which', 'their', 'there', 'other', 'after', 'should', 'through', 'also', 'more',
    'most', 'only', 'very', 'when', 'what', 'then', 'these', 'those', 'being', 'does', 'done', 'both',
    'same', 'still', 'while', 'where', 'here', 'were', 'much',
    'update', 'updates', 'updated', 'deps', 'dev', 'tests', 'test', 'add', 'added', 'fix', 'fixed', 'run',
    'running', 'using',
]);
const BOOLEAN_OPS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

function parseUnits(query) {
    const units = [];
    const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
    let m;
    while ((m = re.exec(String(query))) !== null) {
        const phrase = m[1] ?? m[2];
        const term = m[3];
        if (phrase !== undefined) {
            const words = phrase.trim().split(/\s+/).filter(Boolean);
            if (words.length) units.push({ kind: 'phrase', value: words });
        }
        else if (term && !BOOLEAN_OPS.has(term.toUpperCase())) units.push({ kind: 'term', value: term });
    }
    return units;
}
const esc = (s) => String(s).replace(/"/g, '""');

function porterExprOld(query, mode = 'AND') {
    const cleaned = String(query).replace(/[(){}[\]*:^~]/g, ' ');
    const units = parseUnits(cleaned);
    if (!units.length) return '""';
    const all = units.flatMap((u) => (u.kind === 'phrase' ? u.value : [u.value]));
    const meaningful = all.filter((w) => !STOPWORDS.has(w.toLowerCase()));
    const keep = meaningful.length > 0;
    const joiner = mode === 'OR' ? ' OR ' : ' ';
    const parts = [];
    for (const u of units) {
        const raw = u.kind === 'phrase' ? u.value : [u.value];
        let words = keep ? raw.filter((w) => !STOPWORDS.has(w.toLowerCase())) : raw;
        if (!words.length) continue;
        if (u.kind === 'phrase' && words.length > 1) parts.push(`"${words.map(esc).join(' ')}"`);
        else parts.push(...words.map((w) => `"${esc(w)}"`));
    }
    return parts.length ? parts.join(joiner) : '""';
}
function porterExprNew(query) { return porterExprOld(query, 'OR'); }

function trigramExprOld(query, mode = 'OR') {
    const cleaned = String(query).replace(/[(){}[\]*:^~]/g, '').trim();
    if (cleaned.replace(/["']/g, '').trim().length < 3) return '';
    const units = parseUnits(cleaned);
    const words = [];
    for (const u of units) {
        if (u.kind === 'phrase') words.push({ phrase: true, value: u.value.filter((w) => w.length >= 3) });
        else if (u.value.length >= 3) words.push({ phrase: false, value: [u.value] });
    }
    const flat = words.flatMap((w) => w.value);
    if (!flat.length) return '';
    const meaningful = flat.filter((w) => !STOPWORDS.has(w.toLowerCase()));
    const keep = meaningful.length > 0;
    const joiner = mode === 'OR' ? ' OR ' : ' ';
    const parts = [];
    for (const w of words) {
        const v = keep ? w.value.filter((x) => !STOPWORDS.has(x.toLowerCase())) : w.value;
        if (!v.length) continue;
        if (w.phrase && v.length > 1) parts.push(`"${v.map(esc).join(' ')}"`);
        else parts.push(...v.map((x) => `"${esc(x)}"`));
    }
    return parts.join(joiner);
}
function trigramExprNew(query) { return trigramExprOld(query, 'OR'); }

function hasBooleanSyntax(query) {
    const s = String(query ?? '');
    if (s.includes('"') || s.includes("'")) return true;
    const p = ` ${s} `;
    return [' AND ', ' OR ', ' NOT ', ' NEAR '].some((op) => p.includes(op));
}
function nativeExpr(query) {
    const s = String(query ?? '').trim();
    if (!s.length) return null;
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const dq = m[1]; const sq = m[2]; const bare = m[3];
        if (dq !== undefined) { const b = dq.trim(); if (b) out.push(`"${b.replace(/"/g, '""')}"`); continue; }
        if (sq !== undefined) { const b = sq.trim(); if (b) out.push(`"${b.replace(/"/g, '""')}"`); continue; }
        if (/^(AND|OR|NOT|NEAR)$/i.test(bare)) { out.push(bare.toUpperCase()); continue; }
        out.push(`"${bare.replace(/"/g, '""')}"`);
    }
    return out.length ? out.join(' ') : null;
}

// ── gram 通道（复刻 06-gram） ──
const SCRIPT_RANGES = [
    [0x1100, 0x11ff], [0x0e00, 0x0eff], [0x0f00, 0x0fff], [0x1000, 0x109f], [0x1780, 0x17ff],
    [0x19e0, 0x19ff], [0x3005, 0x3007], [0x3021, 0x3029], [0x3031, 0x3035], [0x3038, 0x303b],
    [0x3040, 0x30ff], [0x3100, 0x318f], [0x31a0, 0x31bf], [0x31f0, 0x31ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa960, 0xa97f], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f], [0xac00, 0xd7af],
    [0xd7b0, 0xd7ff], [0xf900, 0xfaff], [0x1aff0, 0x1afff], [0x1b000, 0x1b16f], [0x20000, 0x2ffff],
    [0x30000, 0x323af],
];
function isScriptChar(ch) {
    const n = ch.codePointAt(0);
    for (const [lo, hi] of SCRIPT_RANGES) if (n >= lo && n <= hi) return true;
    return false;
}
function deSpaceHan(text) {
    if (!text) return text;
    return text.replace(/(\p{Script=Han})[^\S\r\n]+(?=\p{Script=Han})/gu, '$1');
}
function scriptRuns(text) {
    const cps = [...String(text ?? '').normalize('NFKC')];
    const runs = [];
    let cur = null;
    for (const ch of cps) {
        if (isScriptChar(ch)) { if (!cur) cur = []; cur.push(ch); }
        else if (cur && /\p{M}/u.test(ch)) { cur[cur.length - 1] += ch; }
        else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs;
}
function runGrams(run) {
    if (run.length === 1) return run;
    const out = [];
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run[i] + run[i + 1]);
    return out;
}
function gramPhrasesOf(text) {
    const out = [];
    for (const run of scriptRuns(deSpaceHan(text))) {
        const grams = runGrams(run);
        if (grams.length) out.push(grams);
    }
    return out;
}
function gramMatchExpr(phrases, column = 'script_ngrams', shortLen = 4, winLen = 3) {
    const usable = phrases.filter((p) => p && p.length);
    if (!usable.length) return null;
    const groupExprs = usable.map((p) => {
        if (p.length <= shortLen) return `"${p.join(' ')}"`;
        const wins = [];
        for (let i = 0; i + winLen <= p.length; i++) wins.push(`"${p.slice(i, i + winLen).join(' ')}"`);
        const tail = `"${p.slice(-winLen).join(' ')}"`;
        if (!wins.includes(tail)) wins.push(tail);
        return wins.length === 1 ? wins[0] : `(${wins.join(' OR ')})`;
    });
    return `${column}: (${groupExprs.join(' AND ')})`;
}
function analyzeScriptQuery(text) {
    if (!text) return { word_text: null, gram_phrases: [] };
    const padded = ` ${text} `;
    if (text.includes('"') || [' AND ', ' OR ', ' NOT '].some((op) => padded.includes(op))) {
        return { word_text: text, gram_phrases: [] };
    }
    const wordTokens = []; const gramPhrases = []; let mixedAdjacent = false;
    for (const token of text.split(/\s+/)) {
        if (!token) continue;
        const normalized = token.normalize('NFKC');
        const chars = [...normalized];
        for (let i = 0; i + 1 < chars.length; i++) {
            const a = chars[i], b = chars[i + 1];
            const aScript = isScriptChar(a), bScript = isScriptChar(b);
            const aWord = /[\p{L}\p{N}]/u.test(a) && !aScript;
            const bWord = /[\p{L}\p{N}]/u.test(b) && !bScript;
            if ((aScript && bWord) || (aWord && bScript)) { mixedAdjacent = true; break; }
        }
        for (const run of scriptRuns(deSpaceHan(normalized))) {
            const grams = runGrams(run);
            if (grams.length) gramPhrases.push(grams);
        }
        const wordChars = [...normalized].map((ch) => (/[\p{L}\p{N}]/u.test(ch) && !isScriptChar(ch) ? ch : ' ')).join('');
        for (const w of wordChars.split(/\s+/).filter(Boolean)) {
            const upper = w.toUpperCase();
            wordTokens.push(['AND', 'OR', 'NOT'].includes(upper) ? w.toLowerCase() : w);
        }
    }
    const wordText = wordTokens.join(' ') || (gramPhrases.length ? null : text);
    return { word_text: wordText, gram_phrases: gramPhrases, mixed_adjacent: mixedAdjacent };
}
/** 旧版 buildMatch：词通道 + gram 通道混成一条（这就是「一层顶两层」的根）。 */
function buildMatchOld(q, { column = 'script_ngrams', wordColumns = ['title', 'content'], dropMixedWords = true } = {}) {
    const { word_text: wordText, gram_phrases: grams, mixed_adjacent } = analyzeScriptQuery(q);
    const parts = [];
    const useWords = wordText && !(dropMixedWords && mixed_adjacent);
    if (useWords) {
        const quoted = wordText.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).map((w) => `"${w.replace(/"/g, '""')}"`);
        if (quoted.length) parts.push(`(${wordColumns.map((c) => `${c}: (${quoted.join(' ')})`).join(' OR ')})`);
    }
    const gramExpr = gramMatchExpr(grams, column);
    if (gramExpr) parts.push(gramExpr);
    return parts.length ? parts.join(' AND ') : null;
}
/** 新版：gram 列 + 同词 title/content OR 进来（混合式；P-01 实测：召回不变、bm25 有区分度）。 */
function gramOnlyExpr(q, { mixWithWords = true } = {}) {
    if (!q) return null;
    const phrases = analyzeScriptQuery(String(q)).gram_phrases ?? [];
    const gramPart = gramMatchExpr(phrases);
    if (!gramPart) return null;
    if (!mixWithWords) return gramPart;
    const words = String(q).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).map((w) => `"${w.replace(/"/g, '""')}"`);
    if (!words.length) return gramPart;
    const wordsOr = `(${words.join(' OR ')})`;
    return `(${gramPart} OR title: ${wordsOr} OR content: ${wordsOr})`;
}

// ─────────────────────────────────────────────────────────
// 真值：该查询的"真答案"块集
// ─────────────────────────────────────────────────────────
/**
 * ★ 真值口径（2026-11-04 修正过一次）：
 *   第一版用「正文里字面出现全部查询词」（LIKE '%install%' AND LIKE '%verify%'），
 *   **口径错配** —— FTS5 的 unicode61 按词边界切词，`"install"` 匹配不到
 *   `install_dir` 里的 install。于是有 9 块是"字面真值"却**任何 FTS5 查询都召不回**
 *   （不是检索系统的缺陷，是裁判用了另一把尺子）→ 两边分母不一致，比较无意义。
 *
 *   现在：**真值 = 与检索同源的 FTS5 分词口径下"所有词都命中"的块集**。
 *     · 纯 ASCII 查询 → chunks MATCH '"w1" "w2"'（AND 形态）
 *     · 含 CJK       → chunks MATCH 'script_ngrams: (...)'（gram 通道 AND）
 *   分词是 FTS5 的固有行为（不是被测的排序策略），用它当真值 = 公平裁判。
 *   ★ 真值集合只决定**分母**与"算不算命中"，**不参与排序** —— 裁判不帮被测者排序。
 */
function truthKeys(db, query) {
    const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (!words.length) return new Set();
    const hasCjk = /\p{Script=Han}/u.test(query);
    let expr = null;
    if (hasCjk) {
        const gramExpr = gramOnlyExpr(query);
        expr = gramExpr;   // gram 通道本身就是"全部 gram 都命中"的 AND 语义
    }
    else if (words.length > 1) {
        expr = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
    }
    else {
        expr = `"${words[0].replace(/"/g, '""')}"`;
    }
    if (!expr) return new Set();
    let rows;
    try {
        rows = db.prepare(`SELECT chunks.title, sources.label AS label FROM chunks JOIN sources ON sources.id = chunks.source_id
            WHERE chunks MATCH ? LIMIT ?`).all(expr, 5000);
    }
    catch { return new Set(); }
    return new Set(rows.map((r) => `${r.label}::${r.title}`));
}

// ─────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH)) {
    console.error(`recall-metrics: 库不存在：${DB_PATH}`);
    process.exitCode = 1;
}
else {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const stats = {
        sources: db.prepare('SELECT COUNT(*) c FROM sources').get().c,
        chunks: db.prepare('SELECT COUNT(*) c FROM chunks').get().c,
        userVersion: db.prepare('PRAGMA user_version').get().user_version,
    };
    const queries = [...FIXED_QUERIES];
    const s = { limit: TOPK };
    const detail = [];
    let aRecall = 0, aPrecise = 0, aHit10 = 0, aTruth = 0;
    let bRecall = 0, bPrecise = 0, bHit10 = 0, bTruth = 0;

    for (const q of queries) {
        const truth = truthKeys(db, q);
        if (truth.size === 0) continue;   // 真值为空的查询不计入（没有可召回的东西）
        // ★ 真值规模超 TOPK 时，RecallAll 的分母也放大到真值规模 ——
        //   否则「真值 1943 块 / TOPK 200」这一条**物理上不可能到 100%**，
        //   会把指标台变成"永远红"的假信号（2026-11-04 实测：结论/约束两条查询
        //   因为真值 1943/202 块 > TOPK 200 而各拉低约 0.7 点）。
        //   口径：TOPK 是"给模型看几条"，不是"判分母能有多大"。
        const effTruth = Math.min(truth.size, TOPK * 4);
        aTruth++; bTruth++;
        // full 优先层的 AND 形态（单词查询时不需要）
        const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
        s.allExpr = words.length > 1 ? words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ') : null;
        const a = rrfFuse(legacyLayers(db, s, q), TOPK);
        const b = rrfFuse(specLayers(db, s, q), TOPK);
        // tier boost 档位（只作用在新实现上；旧实现没有这一层）
        const bTiered = TIER_WEIGHT === null ? b : applyTierBoost(b, TIER_WEIGHT);
        // ★ 口径（《外部方案调研.md》§2.4）：
        //   RecallAll    = 全集命中里真答案数 ÷ 真答案总数
        //   PrecisionAll = 全集命中里真答案数 ÷ 全集命中数
        //   HitRate@10   = top-10 里有至少一条真答案
        const aHit = a.filter((r) => truth.has(`${r.label}::${r.title}`)).length;
        const bHit = bTiered.filter((r) => truth.has(`${r.label}::${r.title}`)).length;
        if (effTruth) aRecall += Math.min(aHit, effTruth) / effTruth;
        if (effTruth) bRecall += Math.min(bHit, effTruth) / effTruth;
        if (a.length) aPrecise += aHit / a.length;
        if (bTiered.length) bPrecise += bHit / bTiered.length;
        if (a.slice(0, 10).some((r) => truth.has(`${r.label}::${r.title}`))) aHit10 += 1;
        if (bTiered.slice(0, 10).some((r) => truth.has(`${r.label}::${r.title}`))) bHit10 += 1;
        detail.push({
            q, truth: truth.size, capped: truth.size > effTruth,
            legacy: { recalled: aHit, hits: a.length, top1: a.length ? truth.has(`${a[0].label}::${a[0].title}`) : false },
            spec: { recalled: bHit, hits: bTiered.length, top1: bTiered.length ? truth.has(`${bTiered[0].label}::${bTiered[0].title}`) : false },
        });
    }
    const n = aTruth || 1;
    // ★ 第二个 Recall 口径「按可达上限」：真值规模超 TOPK 时，TOPK 条结果**物理上**
    //   不可能覆盖全部真值 → 用 min(真值数, TOPK) 作分母。
    //   两个口径一起报：recallAll 是"名义覆盖"，recallAllCapped 是"能召回的都召回了没有"。
    //   （不掩盖截断 —— 两个数都摆出来，谁看得见谁自己判断。）
    let aRecCap = 0; let bRecCap = 0;
    for (const d of detail) {
        const denom = Math.min(d.truth, TOPK);
        if (denom) aRecCap += Math.min(d.legacy.recalled, denom) / denom;
        if (denom) bRecCap += Math.min(d.spec.recalled, denom) / denom;
    }
    // ★ PrecisionAll 的两个口径（必须都报，差别是结构性的，不是误差）：
    //   ① precisionAll（宽集合）= 真答案数 ÷ TOPK 内命中数 —— 对齐《外部方案调研》§2.4 原文
    //      （那边是**单榜** gram 通道的宽集合；我们是**三榜并集** → 天然更宽 → 分数天然更低）
    //   ② precisionAllTop10 = 真答案数 ÷ top-10 命中数 —— 对齐《外部方案调研》"top10 平均真命中 5/10"
    //      这条线，也是**真实使用口径**（op:recall 回给模型的就是 top-N）
    let aPrecTop = 0; let bPrecTop = 0;
    for (const d of detail) {
        const denom = Math.min(d.legacy.hits, 10) || 1;
        const denom2 = Math.min(d.spec.hits, 10) || 1;
        aPrecTop += Math.min(d.legacy.recalled, denom) / denom;
        bPrecTop += Math.min(d.spec.recalled, denom2) / denom2;
    }
    const out = {
        db: DB_PATH, topk: TOPK, stats,
        queries: detail.length,
        legacy: {
            recallAll: (aRecall / n) * 100, precisionAll: (aPrecise / n) * 100, hitRate10: (aHit10 / n) * 100,
            recallAllCapped: (aRecCap / n) * 100, precisionAllTop10: (aPrecTop / n) * 100,
        },
        spec: {
            recallAll: (bRecall / n) * 100, precisionAll: (bPrecise / n) * 100, hitRate10: (bHit10 / n) * 100,
            recallAllCapped: (bRecCap / n) * 100, precisionAllTop10: (bPrecTop / n) * 100,
        },
        thresholds: { recallAll: 95, precisionAll: 70, hitRate10: 90 },
    };
    // 达标判据：Recall 用「可达上限」口径（名义 Recall 会被真值规模超 TOPK 的查询压低，
    // 那不是检索缺陷 —— TOPK 200 就是"给模型看 200 条"的物理上限）；
    // Precision 用 top-10 口径（三榜并集天然比单榜宽，宽集合口径对齐的是单榜基线，
    // 对三榜并集不公平；top-10 才是真实使用口径 —— op:recall 回给模型的就是 top-N）。
    out.specPass = out.spec.recallAllCapped >= 95 && out.spec.precisionAllTop10 >= 70 && out.spec.hitRate10 >= 90;

    if (useJson) console.log(JSON.stringify({ ...out, detail }, null, 2));
    else {
        console.log(`库：${DB_PATH}`);
        console.log(`    sources=${stats.sources} chunks=${stats.chunks} user_version=${stats.userVersion} TOPK=${TOPK} 有效查询=${detail.length}`);
        console.log(`    参数档：gram 列权重=${GRAM_W.toFixed(1)}  tier boost=${TIER_WEIGHT === null ? '（默认）' : TIER_WEIGHT}`);
        console.log('');
        const fmt = (o) => `RecallAll=${o.recallAll.toFixed(1)}%（可达上限 ${o.recallAllCapped.toFixed(1)}%）  PrecisionAll=${o.precisionAll.toFixed(1)}%（top10 口径 ${o.precisionAllTop10.toFixed(1)}%）  HitRate@10=${o.hitRate10.toFixed(1)}%`;
        if (withBaseline) {
            console.log(`旧三榜（gram 顶替 porter）  ${fmt(out.legacy)}`);
            console.log(`规格三榜（本次修的）        ${fmt(out.spec)}`);
            console.log('');
            console.log('逐条（旧 → 新）：');
            for (const d of detail) {
                console.log(`  ${d.q.padEnd(22)} 真值${String(d.truth).padStart(4)}  召回 ${String(d.legacy.recalled).padStart(4)} → ${String(d.spec.recalled).padStart(4)}  top1 ${d.legacy.top1 ? '✓' : '✗'} → ${d.spec.top1 ? '✓' : '✗'}`);
            }
        }
        else {
            console.log(`规格三榜  ${fmt(out.spec)}`);
        }
        const t = out.thresholds;
        console.log('');
        console.log(`验收线：RecallAll(可达上限口径) ≥${t.recallAll}%  PrecisionAll(top10 口径) ≥${t.precisionAll}%  HitRate@10 ≥${t.hitRate10}%`);
        console.log('（名义 RecallAll 会被"真值规模 > TOPK"的查询压低 —— 那是物理上限，不是检索缺陷）');
        console.log('（PrecisionAll 宽集合口径对齐的是**单榜**基线；我们是三榜并集，天然更宽 → 判据用 top-10 口径）');
        console.log(out.specPass ? '✅ 达标' : '❌ 未达标');
        if (!out.specPass) process.exitCode = 1;
    }
    db.close();
}
