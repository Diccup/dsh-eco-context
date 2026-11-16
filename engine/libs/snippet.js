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
 * libs/snippet.js — 窗口化截断（2.0 `core/store/snippet.ts` 的自有移植）
 *
 * 干什么：从一块**很长的正文**里，按查询词的命中位置切出一段**连续的窗口**回给模型。
 * 为什么这样：库的第一使命是**节约上下文**。1.0.0 把 FTS5 的 highlight 全量塞回模型
 *        （实测单条最大 4,090 B / 一次 7,944 B）—— 那不是"节约"，是"把库倒给模型"。
 *        2.0 的口径（ADR-0016 / D-SEARCH-7）：**正文永远是一段连续的原文切片**，
 *        不做实体编码、不插标记；窗口按词的命中位置选；预算内才给。
 *
 * 取自哪：`2.0引擎拆解/_upstream/src/context-mode-2.0.0-next.31/src/core/store/snippet.ts`
 *   （311 行，`buildSnippet` + `snippetTerms`）。维护方 2026-11-04 定：「别抄 1.2.2 的，要抄 2.0 的」。
 *   本文件是 TypeScript → JavaScript 的移植：去掉类型标注，逻辑保持一致。
 *
 * 三条不许违反：
 *   ① 正文必须是**原文的一段连续切片**（不编码、不插标记、不改字）
 *   ② 按**字节预算**给（不是字符数）—— 中文 1 字 3 字节，按字符算会超预算 3 倍
 *   ③ 围栏代码块**整块回来**（≤ codeMaxBytes），超了才按行切并标 "[lines a-b of N]"
 */

const K1 = 1.2;             // BM25 tf 饱和（Robertson/Zaragoza 标准值）
const B = 0.75;             // BM25 长度归一（标准值）
const MAX_POSITIONS = 4096; // 每词的位置上限（超大单行也不至于爆）

/** 散文块默认字节上限（2.0 的 SNIPPET_MAX_BYTES = 800）。 */
export const SNIPPET_MAX_BYTES = 800;
/** 围栏代码块默认字节上限（2.0 的 SNIPPET_CODE_MAX_BYTES = 2048）。 */
export const SNIPPET_CODE_MAX_BYTES = 2048;

function isAlnum(c) {
    return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c > 127;
}
function isUpper(c) { return c >= 65 && c <= 90; }
function isLowerOrDigit(c) { return (c >= 97 && c <= 122) || (c >= 48 && c <= 57); }

/** 标识符拆词：在非字母数字处断、也在 lower→Upper（camelCase）处断。 */
function identParts(w) {
    const parts = [];
    let cur = '';
    for (let i = 0; i < w.length; i++) {
        const c = w.charCodeAt(i);
        if (!isAlnum(c)) {
            if (cur !== '') parts.push(cur);
            cur = '';
            continue;
        }
        if (cur !== '' && isUpper(c) && isLowerOrDigit(w.charCodeAt(i - 1))) {
            parts.push(cur);
            cur = '';
        }
        cur += w[i];
    }
    if (cur !== '') parts.push(cur);
    return parts;
}

/**
 * 查询词 → 加权词项（lower case）。整符号 2 分，其组成部分 1 分，普通词 1 分。
 * @param {readonly string[]} words
 * @returns {Array<{text:string, weight:number, symbol:boolean}>}
 */
export function snippetTerms(words) {
    const out = new Map();
    const add = (text, weight, symbol) => {
        if (text === '') return;
        const prev = out.get(text);
        if (!prev || prev.weight < weight) out.set(text, { text, weight, symbol });
    };
    for (const raw of words) {
        let a = 0;
        let b = raw.length;
        while (a < b && !isAlnum(raw.charCodeAt(a))) a++;
        while (b > a && !isAlnum(raw.charCodeAt(b - 1))) b--;
        const w = raw.slice(a, b);
        if (w === '') continue;
        const parts = identParts(w);
        if (parts.length > 1) {
            add(w.toLowerCase(), 2, true);
            for (const p of parts) if (p.length >= 2) add(p.toLowerCase(), 1, false);
        }
        else {
            add(w.toLowerCase(), 1, false);
        }
    }
    return [...out.values()];
}

function byteLen(s) { return Buffer.byteLength(s, 'utf8'); }

/**
 * 造窗口。
 * @param {string} row 整块正文
 * @param {readonly {text:string,weight:number,symbol:boolean}[]} given 加权词项
 * @param {number} maxBytes 散文预算（字节）
 * @param {number} [codeMaxBytes] 围栏块预算（字节）
 * @returns {string} 窗口（原文的连续切片）
 */
export function buildSnippet(row, given, maxBytes, codeMaxBytes = SNIPPET_CODE_MAX_BYTES) {
    if (!row) return '';
    const codeCap = Math.max(maxBytes, codeMaxBytes);

    // ---- 行表 ----
    const ls = [];
    const le = [];
    for (let p = 0; ;) {
        const n = row.indexOf('\n', p);
        ls.push(p);
        if (n < 0) { le.push(row.length); break; }
        le.push(n);
        p = n + 1;
    }
    const L = ls.length;
    const lb = new Array(L);
    const cb = new Array(L);
    let acc = 0;
    for (let i = 0; i < L; i++) {
        cb[i] = acc;
        lb[i] = L === 1 ? byteLen(row) : byteLen(row.slice(ls[i], le[i]));
        acc += lb[i] + 1;
    }
    const rangeBytes = (i, j) => cb[j] + lb[j] - cb[i];
    const slice = (i, j) => row.slice(ls[i], le[j]);

    // ---- 块：围栏（``` 或 ~~~，最多 3 个前导空格）与空行分隔的段落 ----
    const fenceOf = (i) => {
        let p = ls[i];
        const end = Math.min(le[i], p + 3);
        while (p < end && row.charCodeAt(p) === 32) p++;
        const c = row.charCodeAt(p);
        if ((c !== 96 && c !== 126) || row.charCodeAt(p + 1) !== c || row.charCodeAt(p + 2) !== c || p + 2 >= le[i]) return '';
        return row.slice(p, p + 3);
    };
    const blank = (i) => {
        for (let p = ls[i]; p < le[i]; p++) {
            const c = row.charCodeAt(p);
            if (c !== 32 && c !== 9 && c !== 13) return false;
        }
        return true;
    };
    const blocks = [];
    const fenceClose = new Map();
    for (let i = 0; i < L;) {
        const f = fenceOf(i);
        if (f !== '') {
            let j = i + 1;
            while (j < L && fenceOf(j) !== f) j++;
            const closed = j < L;
            fenceClose.set(blocks.length, closed ? j : -1);
            blocks.push({ first: i, last: closed ? j : L - 1, code: true });
            i = (closed ? j : L - 1) + 1;
            continue;
        }
        if (blank(i)) { i++; continue; }
        let j = i;
        while (j + 1 < L && !blank(j + 1) && fenceOf(j + 1) === '') j++;
        blocks.push({ first: i, last: j, code: false });
        i = j + 1;
    }
    if (blocks.length === 0) return clipLine(row, 0, row.length, -1, maxBytes);

    // ---- 词位置（token 起点，大小写不敏感）----
    const lower = row.toLowerCase();
    const hay = lower.length === row.length ? lower : row;
    const find = (t) => {
        const out = [];
        if (t.text === '') return out;
        for (let p = hay.indexOf(t.text); p >= 0 && out.length < MAX_POSITIONS; p = hay.indexOf(t.text, p + 1)) {
            const prev = p === 0 ? 32 : row.charCodeAt(p - 1);
            if (!isAlnum(prev) || (isLowerOrDigit(prev) && isUpper(row.charCodeAt(p)))) out.push(p);
        }
        return out;
    };
    let terms = given;
    let pos = terms.map(find);
    // 打字容错兜底：块是靠 trigram 或编辑距离回来的 → 原样一个词都不在里面。
    // 于是 5 字符以上的词改用「前 max(4, len-2) 个字符」再找一次。
    if (pos.every((p) => p.length === 0)) {
        terms = given.filter((t) => t.text.length >= 5).map((t) => ({ ...t, text: t.text.slice(0, Math.max(4, t.text.length - 2)) }));
        pos = terms.map(find);
    }
    const count = (ti, a, b) => {
        const ps = pos[ti];
        let lo = 0; let hi = ps.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (ps[m] < a) lo = m + 1; else hi = m; }
        let n = 0;
        for (let k = lo; k < ps.length && ps[k] < b; k++) n++;
        return n;
    };

    // ---- BM25 风格的块打分 ----
    const N = blocks.length;
    const blen = blocks.map((bk) => rangeBytes(bk.first, bk.last));
    const avg = blen.reduce((a, b) => a + b, 0) / N || 1;
    const tf = blocks.map((bk) => terms.map((_, ti) => count(ti, ls[bk.first], le[bk.last])));
    const idf = terms.map((_, ti) => {
        let df = 0;
        for (let k = 0; k < N; k++) if (tf[k][ti] > 0) df++;
        return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    });
    const weight = (ti, code) => terms[ti].weight * (terms[ti].symbol && code ? 2 : 1) * idf[ti];
    const scores = blocks.map((bk, k) => {
        let s = 0;
        const norm = K1 * (1 - B + (B * blen[k]) / avg);
        terms.forEach((_, ti) => {
            const f = tf[k][ti];
            if (f > 0) s += (weight(ti, bk.code) * f * (K1 + 1)) / (f + norm);
        });
        return s;
    });
    let best = 0;
    for (let k = 1; k < N; k++) if (scores[k] > scores[best]) best = k;
    const bk = blocks[best];
    const lineScore = (i) => {
        let s = 0;
        terms.forEach((_, ti) => { if (count(ti, ls[i], le[i]) > 0) s += weight(ti, bk.code); });
        return s;
    };
    const firstHit = (i) => {
        let at = -1; let w = -1;
        terms.forEach((_, ti) => {
            const c = count(ti, ls[i], le[i]);
            if (c === 0 || weight(ti, bk.code) <= w) return;
            const ps = pos[ti];
            let lo = 0; let hi = ps.length;
            while (lo < hi) { const m = (lo + hi) >> 1; if (ps[m] < ls[i]) lo = m + 1; else hi = m; }
            at = ps[lo];
            w = weight(ti, bk.code);
        });
        return at;
    };

    // 预算内最长的连续整行窗口，从最佳行向两边长。
    const lineWindow = (a, b, budget) => {
        let anchor = a;
        let top = -1;
        for (let i = a; i <= b; i++) { const s = lineScore(i); if (s > top) { top = s; anchor = i; } }
        if (lb[anchor] > budget) return null;
        let i = anchor; let j = anchor;
        for (;;) {
            const up = i > a && rangeBytes(i - 1, j) <= budget;
            const down = j < b && rangeBytes(i, j + 1) <= budget;
            if (!up && !down) break;
            if (up && down) { if (lineScore(i - 1) > lineScore(j + 1)) i--; else j++; }
            else if (up) i--;
            else j++;
        }
        return [i, j];
    };

    // ---- 围栏代码块 ----
    if (bk.code) {
        if (blen[best] <= codeCap) return grow(best);
        const close = fenceClose.get(best) ?? -1;
        const open = bk.first;
        const innerA = open + 1;
        const innerB = close >= 0 ? close - 1 : bk.last;
        const total = innerB - innerA + 1;
        const openText = slice(open, open);
        const closeText = close >= 0 ? slice(close, close) : fenceOf(open);
        const markerMax = byteLen(`\n[lines ${total}-${total} of ${total}]`);
        const budget = codeCap - lb[open] - 1 - 1 - byteLen(closeText) - markerMax;
        if (total <= 0) return clipLine(row, ls[open], le[bk.last], -1, codeCap);
        const win = lineWindow(innerA, innerB, budget);
        if (win === null) {
            let anchor = innerA; let top = -1;
            for (let i = innerA; i <= innerB; i++) { const s = lineScore(i); if (s > top) { top = s; anchor = i; } }
            const body = clipLine(row, ls[anchor], le[anchor], firstHit(anchor), Math.max(0, budget));
            const n = anchor - innerA + 1;
            return `${openText}\n${body}\n${closeText}\n[lines ${n}-${n} of ${total}]`;
        }
        const [i, j] = win;
        return `${openText}\n${slice(i, j)}\n${closeText}\n[lines ${i - innerA + 1}-${j - innerA + 1} of ${total}]`;
    }

    // ---- 散文 ----
    if (blen[best] <= maxBytes) return grow(best);
    const win = lineWindow(bk.first, bk.last, maxBytes);
    if (win !== null) return slice(win[0], win[1]);
    let anchor = bk.first; let top = -1;
    for (let i = bk.first; i <= bk.last; i++) { const s = lineScore(i); if (s > top) { top = s; anchor = i; } }
    return clipLine(row, ls[anchor], le[anchor], firstHit(anchor), maxBytes);

    // 相邻整块按分数并入（分数高的优先，同分取下一块）—— 窗口带围栏时可用 codeCap，纯散文用 maxBytes。
    function grow(k) {
        let a = k; let b = k;
        let code = blocks[k].code;
        const fits = (i, j, c) => rangeBytes(blocks[i].first, blocks[j].last) <= (c ? codeCap : maxBytes);
        for (;;) {
            const up = a > 0 && fits(a - 1, b, code || blocks[a - 1].code);
            const down = b < N - 1 && fits(a, b + 1, code || blocks[b + 1].code);
            if (!up && !down) break;
            if (up && down) { if (scores[a - 1] > scores[b + 1]) a--; else b++; }
            else if (up) a--;
            else b++;
            code = code || blocks[a].code || blocks[b].code;
        }
        return slice(blocks[a].first, blocks[b].last);
    }
}

/**
 * 切一条超预算的行 [s, e)：从命中点前 1/4 预算处起（附近有空格就在空格处断），
 * 尾端落在后半段最后一个空格（没有就按码点边界切）。**不劈 UTF-8 字符**。
 */
function clipLine(row, s, e, hit, budget) {
    if (budget <= 0) return '';
    let start = s;
    if (hit > s) {
        start = Math.max(s, hit - (budget >> 2));
        if (start > s) {
            const sp = row.indexOf(' ', start);
            start = sp >= 0 && sp < hit ? sp + 1 : start;
        }
    }
    const cu = row.charCodeAt(start);
    if (start > s && cu >= 0xdc00 && cu <= 0xdfff) start++;
    let used = 0;
    let end = start;
    while (end < e) {
        const c = row.charCodeAt(end);
        const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < e;
        const n = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
        if (used + n > budget) break;
        used += n;
        end += pair ? 2 : 1;
    }
    if (end < e) {
        const sp = row.lastIndexOf(' ', end - 1);
        if (sp > start && sp - start >= (end - start) >> 1) end = sp;
    }
    return row.slice(start, end);
}

/**
 * 便捷面：给一段正文 + 查询词 → 窗口。
 * @param {string} content 整块正文
 * @param {string} query 查询串
 * @param {number} maxBytes 预算
 * @returns {string}
 */
export function snippet(content, query, maxBytes = SNIPPET_MAX_BYTES) {
    if (!content) return '';
    if (byteLen(content) <= maxBytes) return content;
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (!words.length) return content.slice(0, maxBytes);
    return buildSnippet(content, snippetTerms(words), maxBytes);
}
