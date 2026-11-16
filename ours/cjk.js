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
 * CJK segmentation for context-mode's FTS5 index.
 *
 * context-mode builds two FTS5 tables with `tokenize='porter unicode61'` and
 * `tokenize='trigram'`. Neither treats CJK text as searchable:
 *
 *   - `unicode61` classifies a run of Han characters as ONE token, so the
 *     document "缓存走本地文件就行" indexes as a single term and a query for
 *     "缓存" matches nothing.
 *   - `trigram` indexes 3-character windows, so only CJK queries of three or
 *     more characters can match; two-character words like "缓存" never do.
 *
 * The fix applied here is applied on BOTH sides of the index:
 *
 *   - writes segment CJK runs into single characters separated by spaces,
 *     which makes `unicode61` emit one token per character;
 *   - queries segment identically, so "缓存方案" becomes the tokens
 *     `缓 存 方 案` and the searcher can match them.
 *
 * The query side deliberately does NOT wrap the segmented run in a phrase.
 * Phrase semantics were tried first and made retrieval worse: a document
 * saying "缓存走本地文件" and a query saying "缓存方案用什么" share the
 * prefix but diverge immediately, so an adjacency requirement rejects the
 * result a caller actually wanted. Emitting single tokens instead lets
 * upstream's `sanitizeQuery` build an AND expression, and BM25 ranks the
 * document that shares more characters first, which is the ranking a
 * character-based index can honestly provide. See {@link buildCjkQuery}.
 */
/** Han, Hiragana, Katakana, and Hangul ranges that need segmentation. */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
/** Return whether a string contains any character that needs segmentation. */
export function hasCjk(value) {
    return CJK_PATTERN.test(value);
}
/**
 * Segment every CJK run into space-separated single characters.
 *
 * Non-CJK text is preserved verbatim, so latin identifiers, paths, and version
 * strings keep their original token shapes.
 *
 * @param value - document text or query text.
 * @returns the segmented text.
 */
export function segmentCjk(value) {
    if (!hasCjk(value))
        return value;
    return value.replace(CJK_RUN_PATTERN, run => ` ${Array.from(run).join(' ')} `);
}
/**
 * Rewrite a CJK query so the upstream FTS5 tokenizer can match it.
 *
 * Two storage shapes exist and both must stay reachable:
 *
 *   - content-argument indexing passes through {@link segmentCjk} on the bridge,
 *     so those chunks store space-separated single characters;
 *   - path/directory indexing is read by the engine directly and stores CJK as
 *     written (punctuation-delimited runs — "验收标准" survives as one token
 *     inside "六、验收标准(总)").
 *
 * Short runs (<= {@link MAX_RUN_SEGMENT_CHARS}) emit both shapes: the written
 * form matches path-indexed chunks, the segmented form matches content-indexed
 * chunks. Long runs do NOT get the single-character expansion: an unbroken
 * 20-character run expanded to 20 single tokens matches almost everything in a
 * character-indexed table (each token is common), buries the real hit under BM25
 * noise, and as one contiguous token still fails to EQUAL the whole-run token a
 * path-indexed chunk stores. Instead long runs additionally emit sliding
 * 3-character windows — exactly the shape the engine's trigram table indexes —
 * capped at {@link MAX_QUERY_TERMS} windows so the OR expression stays bounded.
 * The contiguous form is always kept for whole-token matches.
 *
 * Joining is safe because the engine runs every whitespace-separated term
 * through OR matching (search + searchTrigram both OR and RRF-fuse), and the
 * reranker drops query terms shorter than 2 characters, which single
 * characters are not once spaced out inside the dual form.
 *
 * @param query - the raw model-supplied query.
 * @returns the dual-form query, or the input unchanged when it has no CJK text.
 */
const MAX_RUN_SEGMENT_CHARS = 8;
const MAX_QUERY_TERMS = 6;
export function buildCjkQuery(query) {
    const raw = query.replace(/\s+/g, ' ').trim();
    if (!hasCjk(query))
        return raw;
    // Per CJK run: short runs expand to single characters (matches the
    // content-indexed storage), long runs expand to sliding 3-character
    // windows capped at MAX_QUERY_TERMS (matches the engine trigram table
    // without flooding BM25 with common single tokens).
    const expanded = raw.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g, (run) => {
        const chars = Array.from(run);
        if (chars.length <= MAX_RUN_SEGMENT_CHARS)
            return ` ${chars.join(' ')} `;
        const windows = [];
        for (let i = 0; i + 3 <= chars.length && windows.length < MAX_QUERY_TERMS; i++)
            windows.push(chars.slice(i, i + 3).join(''));
        return ` ${windows.join(' ')} `;
    });
    const segmented = expanded.replace(/\s+/g, ' ').trim();
    const terms = [raw];
    if (segmented !== raw)
        terms.push(segmented);
    const unique = [];
    const seen = new Set();
    for (const term of terms.join(' ').split(' ')) {
        if (term.length > 0 && !seen.has(term)) {
            seen.add(term);
            unique.push(term);
        }
    }
    return unique.join(' ');
}
