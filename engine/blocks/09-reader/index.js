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
 * 09-reader — 查询（三榜 MATCH → RRF(K=60) → 四 boost → fuzzy 二段）
 *
 * 干什么：一个查询同时走 porter 榜、gram 榜、trigram 榜，各自出 rank 列表 → RRF 融合 →
 *        四 boost 重排（title / proximity / phrase / tier）→ 截断。
 * 为什么这样：① gram 通道不进 RRF 中文就塌陷（01-立项书 §六 裁决④）；
 *            ② 三榜全 0 才许触发 fuzzy（原版是无条件"RRF 空就纠错"，会掩盖真 bug）；
 *            ③ tier boost 零表结构成本（chunks.session_id 已在）。
 * 边界：只读；不写 accessed_ts（续命归 08-writer，且每 source 每日最多一次）。
 *
 * ★★★ 2026-11-04 甲档重写：三榜必须是**三层不同的 MATCH 表达式** ★★★
 *   原来的写法（已删）：
 *     const pRows = oneLayer('porter', gramExpr ?? porterExpr, …);   // ← gram 顶替 porter
 *     const gRows  = gramExpr ? oneLayer('porter', gramExpr, …) : [];  // ← 同表同表达式
 *   → 两层跑的是**同一条表达式、同一张表**，RRF 融合的是"同一张榜两次"。
 *     判据（06 报告 §三.1）：**每层的 MATCH 表达式互不相同**，否则三榜是假的。
 *   现在：
 *     porter 榜  → tokenize.porterExpr(q,'OR')      打 chunks.title/content（英文/标识符）
 *     gram 榜    → gram.gramOnlyExpr(q)              打 chunks.script_ngrams（中文）
 *     trigram 榜 → tokenize.trigramExpr(q,'OR')      打 chunks_trigram（≥3 字子串）
 *   gram 层只管 CJK：查询里没有 CJK → 该层不出榜（不是"出一张空榜冒充三榜"）。
 *
 * 五条不许违反（血泪来的）：
 *   ① bm25 三个参数一个不许漏（libs/sql.js 的 bm25() 已强制）
 *   ② 时间衰减禁止（消融实测负收益）
 *   ③ 标题加权对 gram 列不加
 *   ④ LIKE 转义保留（#646）
 *   ⑤ 返回形状固定 − 24 项 {title,content,source,rank,contentType,highlighted,timestamp,sessionId}
 */

import { err } from '../../libs/err.js';
import { bm25, highlight, likeEscape } from '../../libs/sql.js';
import * as sqlContract from '../../libs/sql.js';
import fs from 'node:fs';

export const NAME = 'reader';
export const INVARIANTS = [
    'bm25 三参数不许漏；标题加权不作用于 gram 列',
    '时间衰减禁止（消融负收益）',
    '三榜全 0 才触发 fuzzy',
    'LIKE 转义保留（#646）',
    '查询不写 accessed_ts（续命由 writer 每日节流）',
    '★ 三层的 MATCH 表达式必须互不相同（porter=title/content、gram=script_ngrams、trigram=chunks_trigram）',
    '★ tier boost 判据是 sessionId === 当前会话 id（不是"有 sessionId 就加权"）',
    '★ 含引号/显式 AND OR NOT → 整串交 FTS5 原生解析，不拆词',
];

const RRF_K = 60;

/** M-5 Step0 刷新的节流：文件源刷新要读文件 + 算 hash，**不能每次查询都做**（否则 P95 爆）。 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.tokenize  07-tokenize
 * @param {object} deps.gram      06-gram
 * @param {object} [deps.writer]  08-writer（仅用于 #refreshStaleSources 与续命）
 * @param {string} [deps.dbPath]  库文件绝对路径（M-7 统计 wal_bytes 用）
 * @param {string} [deps.currentSessionId] 当前会话 id（tier boost 判据）
 */
export function createReader(deps) {
    const { db, tokenize, gram } = deps;
    if (!db) throw new Error('09-reader: 缺 db');
    if (!tokenize || !gram) throw new Error('09-reader: 缺 tokenize/gram');

    const BM = BM25_COLUMNS_MAP();
    /** 三榜 SQL：列名与突出段落固定（12 处 bm25 由 sql.js 统一生成）。 */
    const q = {
        porter: db.prepare(`
      SELECT chunks.title, chunks.content, chunks.content_type, chunks.timestamp,
             sources.label, ${bm25('chunks')} AS rank, ${highlight('chunks')} AS highlighted,
             chunks.session_id, chunks.script_ngrams
      FROM chunks JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? ORDER BY rank LIMIT ?`),
        porterLabel: db.prepare(`
      SELECT chunks.title, chunks.content, chunks.content_type, chunks.timestamp,
             sources.label, ${bm25('chunks')} AS rank, ${highlight('chunks')} AS highlighted,
             chunks.session_id, chunks.script_ngrams
      FROM chunks JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' ORDER BY rank LIMIT ?`),
        // ★ full 优先层（2.0 ADR-0009 §8.3 口径，2026-11-04 甲档补）：
        //   `full` = 这一行是不是**所有查询词都出现**。
        //   为什么要它：OR 出榜保证召回，但"两个词都命中"的块必须排在"只命中一个"的块前面。
        //   关键是 **`ORDER BY full DESC` 必须发生在 LIMIT 之前** —— 否则 full 块
        //   在 bm25 排序里靠后，会被 LIMIT 截掉，"全匹配优先"就成了空话
        //   （2026-11-04 指标台实测：不带 full 层时，规格三榜 RecallAll 反而比旧版低 1.3 点）。
        //   单词查询时 full ≡ match → 用不带 full 的语句（省一次子查询）。
        porterFull: db.prepare(`
      SELECT chunks.title, chunks.content, chunks.content_type, chunks.timestamp,
             sources.label, ${bm25('chunks')} AS rank, ${highlight('chunks')} AS highlighted,
             chunks.session_id, chunks.script_ngrams,
             (chunks.rowid IN (SELECT rowid FROM chunks WHERE chunks MATCH ?)) AS full
      FROM chunks JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? ORDER BY full DESC, rank LIMIT ?`),
        porterFullLabel: db.prepare(`
      SELECT chunks.title, chunks.content, chunks.content_type, chunks.timestamp,
             sources.label, ${bm25('chunks')} AS rank, ${highlight('chunks')} AS highlighted,
             chunks.session_id, chunks.script_ngrams,
             (chunks.rowid IN (SELECT rowid FROM chunks WHERE chunks MATCH ?)) AS full
      FROM chunks JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' ORDER BY full DESC, rank LIMIT ?`),
        tri: db.prepare(`
      SELECT chunks_trigram.title, chunks_trigram.content, chunks_trigram.content_type, chunks_trigram.timestamp,
             sources.label, ${bm25('chunks_trigram')} AS rank, ${highlight('chunks_trigram')} AS highlighted,
             chunks_trigram.session_id
      FROM chunks_trigram JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? ORDER BY rank LIMIT ?`),
        triLabel: db.prepare(`
      SELECT chunks_trigram.title, chunks_trigram.content, chunks_trigram.content_type, chunks_trigram.timestamp,
             sources.label, ${bm25('chunks_trigram')} AS rank, ${highlight('chunks_trigram')} AS highlighted,
             chunks_trigram.session_id
      FROM chunks_trigram JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' ORDER BY rank LIMIT ?`),
        vocab: db.prepare('SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?'),
        meta: db.prepare('SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash, accessed_ts FROM sources WHERE label = ?'),
        listSources: db.prepare('SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC'),
        // ★ R13（P1-4）：total_chunks 原来取 `SUM(sources.chunk_count)` —— 那是**写入时**
        //   记下的账，purge（尤其 R4 修好的 session 扫尾）与任何直接删块都不会同步它，
        //   于是 stats 的 chunks 与 state.totalChunks 会对不上（实测差 1，报告里的 off-by-one）。
        //   真块数以 `chunks` 表为准；SUM(chunk_count) 另留 totalChunksBilled 供对账（不等就是漂移）。
        state: db.prepare(`SELECT (SELECT COUNT(*) FROM chunks) AS total_chunks,
                                  (SELECT COALESCE(SUM(chunk_count),0) FROM sources) AS billed_chunks,
                                  (SELECT COUNT(*) FROM sources) AS total_sources,
                                  (SELECT MAX(indexed_at) FROM sources) AS last_indexed_at`),
        chunksBySource: db.prepare(`SELECT c.title, c.content, c.content_type, s.label FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.source_id = ? ORDER BY c.rowid`),
        stats: db.prepare(`SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM chunks WHERE content_type='code') AS codeChunks`),
        distinct: db.prepare('SELECT content FROM chunks WHERE source_id = ?'),
        chunkCountFor: db.prepare('SELECT chunk_count FROM sources WHERE id = ?'),
        idByLabel: db.prepare('SELECT id FROM sources WHERE label = ?'),
        touch: db.prepare('UPDATE sources SET accessed_ts = ? WHERE label = ? AND (accessed_ts IS NULL OR datetime(accessed_ts) < datetime(?))'),
    };

    /** 来源过滤参数：exact 直接用；like 走转义（#646）。 */
    function sourceParam(source, mode) {
        if (mode === 'exact') return source;
        return `%${likeEscape(source)}%`;
    }

    function mapRows(rows) {
        return rows.map((r) => ({
            title: r.title,
            content: r.content,
            source: r.label,
            rank: r.rank,
            contentType: r.content_type,
            highlighted: r.highlighted,
            timestamp: r.timestamp ?? undefined,
            sessionId: r.session_id ?? '',
        }));
    }

    /**
     * 一榜。
     * @param {'porter'|'gram'|'trigram'} layer 榜名（决定打哪张表/哪一列）
     * @param {string} expr MATCH 表达式（**每层必须互不相同**，见文件头）
     * @param {string} [allExpr] AND 形态的表达式（full 优先层用；给了就走 porterFull 语句）
     */
    function oneLayer(layer, expr, limit, source, sourceMode, allExpr) {
        if (!expr) return [];
        if (layer === 'trigram') {
            return source ? mapRows(q.triLabel.all(expr, sourceParam(source, sourceMode), limit))
                : mapRows(q.tri.all(expr, limit));
        }
        // porter 榜与 gram 榜都打 chunks 表，但 MATCH 表达式不同：
        //   porter → title/content 的词表达式；gram → script_ngrams 的列过滤表达式。
        // full 优先层：只在 porter 榜给 allExpr（gram 榜本身就是"全 gram 短语"语义）。
        if (allExpr) {
            return source
                ? mapRows(q.porterFullLabel.all(allExpr, expr, sourceParam(source, sourceMode), limit))
                : mapRows(q.porterFull.all(allExpr, expr, limit));
        }
        return source ? mapRows(q.porterLabel.all(expr, sourceParam(source, sourceMode), limit))
            : mapRows(q.porter.all(expr, limit));
    }

    /**
     * 三榜各出列表 → RRF 融合。返回 [{...result, rank:-score, layers:[...]}]
     * 键 = source::title（同一块在两榜里是同一个实体）。
     *
     * ★ full 优先（2.0 ADR-0009 §8.3）：`full`=1 的块（所有查询词都出现）排在前面。
     *   这是「AND 全匹配优先」——最终定义 §三 明写"用 gram 短语实现，不新增 SQL 分支"，
     *   这里既做了 SQL 层的 ORDER BY full DESC（层内），也做了融合层的 full 优先（层间）。
     */
    function rrfFuse(lists, limit) {
        const scoreMap = new Map();
        for (const [layerName, rows] of lists) {
            for (const [i, r] of rows.entries()) {
                const key = `${r.source}::${r.title}`;
                const inc = 1 / (RRF_K + i + 1);
                const existing = scoreMap.get(key);
                if (existing) {
                    existing.score += inc;
                    existing.layers.push(layerName);
                    existing.full = existing.full || r.full === 1;
                }
                else {
                    scoreMap.set(key, { result: r, score: inc, layers: [layerName], full: r.full === 1 });
                }
            }
        }
        return Array.from(scoreMap.values())
            .sort((a, b) => b.full - a.full || b.score - a.score)
            .slice(0, limit)
            .map(({ result, score, layers, full }) => ({ ...result, rank: -score, layers, full: full ? 1 : 0 }));
    }

    /** proximity 纯函数：最小窗口跨度。 */
    function findAllPositions(text, term) {
        const out = [];
        let i = text.indexOf(term);
        while (i !== -1) { out.push(i); i = text.indexOf(term, i + 1); }
        return out;
    }
    function findMinSpan(lists) {
        if (lists.length === 0) return Infinity;
        if (lists.length === 1) return 0;
        const ptrs = new Array(lists.length).fill(0);
        let minSpan = Infinity;
        while (true) {
            let curMin = Infinity; let curMax = -Infinity; let minIdx = 0;
            for (let i = 0; i < lists.length; i++) {
                const v = lists[i][ptrs[i]];
                if (v < curMin) { curMin = v; minIdx = i; }
                if (v > curMax) curMax = v;
            }
            const span = curMax - curMin;
            if (span < minSpan) minSpan = span;
            ptrs[minIdx]++;
            if (ptrs[minIdx] >= lists[minIdx].length) break;
        }
        return minSpan;
    }
    function countAdjacentPairs(lists, terms, gap = 30) {
        if (lists.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < Math.min(lists.length, terms.length) - 1; i++) {
            const left = lists[i]; const right = lists[i + 1];
            const leftLen = terms[i].length;
            let j = 0;
            for (const p of left) {
                const minStart = p + leftLen; const maxStart = minStart + gap;
                while (j < right.length && right[j] < minStart) j++;
                if (j < right.length && right[j] <= maxStart) { total++; j++; }
            }
        }
        return total;
    }

    /** 四 boost 重排（title / proximity / phrase / tier）。 */
    function applyBoosts(results, query, currentSessionId = '') {
        const terms = tokenize.rankTerms(query);
        const tierWeight = 0.15;
        return results
            .map((r) => {
                // ① title boost：code 块 0.6、prose 0.3（函数名/类名是高信号）
                const titleLower = String(r.title).toLowerCase();
                const titleHits = terms.filter((t) => titleLower.includes(t)).length;
                const titleWeight = r.contentType === 'code' ? 0.6 : 0.3;
                const titleBoost = terms.length > 0 && titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

                // ②③ proximity + phrase（只有 ≥2 词才算）
                let proximityBoost = 0; let phraseBoost = 0;
                if (terms.length >= 2) {
                    const content = String(r.content).toLowerCase();
                    const positions = terms.map((t) => findAllPositions(content, t));
                    if (!positions.some((p) => p.length === 0)) {
                        const minSpan = findMinSpan(positions);
                        proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));
                        phraseBoost = 0.5 * Math.min(1, countAdjacentPairs(positions, terms) / 4);
                    }
                }
                // ④ tier boost：★ 判据必须是「**正是**当前会话的块」——
                //    原来的 `r.sessionId ? tierWeight : 0` 是"有 sessionId 就加权"，
                //    而库里 session_id 全是空串 → 恒 0；就算非空也会给别的会话加权（方向反了）。
                const tierBoost = (currentSessionId && r.sessionId === currentSessionId) ? tierWeight : 0;

                return { result: r, boost: titleBoost + proximityBoost + phraseBoost + tierBoost };
            })
            .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
            .map(({ result }) => result);
    }

    /** fuzzy 纠错（只在三榜全 0 时用）。 */
    const fuzzyCache = new Map();
    function fuzzyCorrect(word) {
        const w = word.toLowerCase().trim();
        if (w.length < 3) return null;
        if (fuzzyCache.has(w)) return fuzzyCache.get(w);
        const maxDist = tokenize.maxEditDistance(w.length);
        const candidates = q.vocab.all(w.length - maxDist, w.length + maxDist);
        let best = null; let bestDist = maxDist + 1; let exact = false;
        for (const { word: cand } of candidates) {
            if (cand === w) { exact = true; break; }
            const d = tokenize.levenshtein(w, cand);
            if (d < bestDist) { bestDist = d; best = cand; }
        }
        const out = exact ? null : (bestDist <= maxDist ? best : null);
        if (fuzzyCache.size >= 256) fuzzyCache.delete(fuzzyCache.keys().next().value);
        fuzzyCache.set(w, out);
        return out;
    }

    /**
     * 统一查询入口。
     *
     * ★ 结构（2026-11-04 甲档）：
     *   ① M-5 Step0：刷新过期文件源（带 60s 节流）
     *   ② 三榜各出 rank 列表 → RRF(K=60) 融合
     *   ③ 四 boost 重排（title / proximity / phrase / tier）
     *   ④ 三榜全 0 → fuzzy 二段
     *
     * @param {{query:string, limit?:number, source?:string, sourceMatchMode?:'like'|'exact',
     *          contentType?:'code'|'prose', sessionIdAllowSet?:Set<string>, offset?:number,
     *          sessionId?:string, sort?:'relevance'|'timeline', refresh?:boolean}} opts
     */
    function search(opts) {
        const {
            query, limit = 3, source, sourceMatchMode = 'like', contentType,
            sessionIdAllowSet, offset = 0, sessionId = '', refresh = true,
        } = opts ?? {};
        if (!query || String(query).trim().length === 0) throw err('NO_QUERY');

        // ① M-5 Step0：文件源过期刷新（mtime → hash → 真变了才重写）。
        //    带 60s 节流：刷新要读文件算 hash，不节流会把 P95 拉爆（红线 15ms）。
        if (refresh) maybeRefreshStaleSources();

        // ② 三榜并行（fetchLimit 放大，融合后再截）
        const fetchLimit = Math.max(limit * 2, 12);
        const boolQuery = tokenize.hasBooleanSyntax(query);
        // ★ 原生布尔（含引号 / 显式 AND OR NOT）→ **整串交 FTS5**，不拆词。
        //   拆词后 `"WAL" AND "checkpoint"` 会变成三词 AND → 命中 0；原生 → 命中 28。
        const native = boolQuery ? tokenize.nativeExpr(query) : null;
        const porterExpr = native ?? tokenize.porterExpr(query, 'OR');
        // ★ full 优先层的 AND 形态：所有词都要出现。**它必须参与 LIMIT 之前的排序**
        //   （ORDER BY full DESC），否则"两个词都命中"的块会被 bm25 排序挤到 LIMIT 之外，
        //   "全匹配优先"就成了空话（2026-11-04 指标台实测：不带 full 层，规格三榜
        //   RecallAll 97.8% < 旧版 99.1%；带上后反超）。
        const allExpr = native ? null : tokenize.porterExpr(query, 'AND');
        // gram 层：原生布尔时也兜底中文段（ignoreBoolean），普通查询只取 CJK 段。
        const gramExpr = gram.gramOnlyExpr(query, { ignoreBoolean: boolQuery });
        const triExpr = boolQuery
            ? (native ?? tokenize.trigramExpr(query, 'OR'))
            : tokenize.trigramExpr(query, 'OR');

        const lists = [];
        const pRows = oneLayer('porter', porterExpr, fetchLimit, source, sourceMatchMode, allExpr);
        if (pRows.length) lists.push(['porter', pRows]);
        // gram 层只在真出榜时进 RRF（空榜不算一层 —— 免得"三榜"名不副实）
        const gRows = gramExpr ? oneLayer('gram', gramExpr, fetchLimit, source, sourceMatchMode) : [];
        if (gRows.length) lists.push(['gram', gRows]);
        const tRows = oneLayer('trigram', triExpr, fetchLimit, source, sourceMatchMode);
        if (tRows.length) lists.push(['trigram', tRows]);

        let fused = rrfFuse(lists, fetchLimit);

        // contentType 过滤（SQL 层没做，因为三榜 SQL 组合太多，这里后置）
        if (contentType) fused = fused.filter((r) => r.contentType === contentType);

        // session allow-set（#737 项目过滤）：空 session_id 的遗留块跨项目可见
        if (sessionIdAllowSet) {
            fused = fused.filter((r) => {
                const sid = r.sessionId ?? '';
                return sid === '' || sessionIdAllowSet.has(sid);
            });
        }

        // ③ fuzzy 二段：**三榜全 0** 才触发（原判据是"porter 榜 0"，那是顶替前的遗留）
        if (fused.length === 0) {
            const words = tokenize.fuzzyWords(query);
            const corrected = words.map((w) => fuzzyCorrect(w) ?? w).join(' ');
            if (corrected !== words.join(' ') && corrected.length > 0) {
                const fLists = [];
                const fp = oneLayer('porter', tokenize.porterExpr(corrected, 'OR'), fetchLimit, source, sourceMatchMode);
                if (fp.length) fLists.push(['porter', fp]);
                const fg = gram.gramOnlyExpr(corrected);
                const fgr = fg ? oneLayer('gram', fg, fetchLimit, source, sourceMatchMode) : [];
                if (fgr.length) fLists.push(['gram', fgr]);
                const ft = oneLayer('trigram', tokenize.trigramExpr(corrected, 'OR'), fetchLimit, source, sourceMatchMode);
                if (ft.length) fLists.push(['trigram', ft]);
                fused = rrfFuse(fLists, fetchLimit);
                if (fused.length > 0) {
                    const reranked = applyBoosts(fused.slice(0, limit + offset), corrected, sessionId);
                    return reranked.slice(offset).map((r) => ({ ...r, matchLayer: 'rrf-fuzzy' }));
                }
            }
            return [];
        }

        // ④ 四 boost 重排 + 截断
        const reranked = applyBoosts(fused.slice(0, limit + offset), query, sessionId);
        return reranked.slice(offset).map((r) => ({ ...r, matchLayer: 'rrf' }));
    }

    /** 单榜直查（诊断用；ctx_recall 不暴露）。 */
    function searchPorter(query, limit = 3, source, mode = 'like') {
        return oneLayer('porter', tokenize.porterExpr(query, 'OR'), limit, source, mode);
    }
    function searchTrigram(query, limit = 3, source, mode = 'like') {
        return oneLayer('trigram', tokenize.trigramExpr(query, 'OR'), limit, source, mode);
    }
    /** gram 层直查（诊断用；只看 script_ngrams 列）。 */
    function searchGram(query, limit = 3, source, mode = 'like') {
        const expr = gram.gramOnlyExpr(query);
        return expr ? oneLayer('gram', expr, limit, source, mode) : [];
    }

    /**
     * M-5 Step0：刷新过期文件源（mtime 快筛 → hash → 真变了才重写）。
     * **60s 节流**：刷新要读文件 + 算 sha256，不节流会把 P95 拉爆（红线 15ms）。
     * 失败静默（刷新失败不该让查询失败）。
     */
    let lastRefreshAt = 0;
    function maybeRefreshStaleSources(force = false) {
        if (!deps.writer || typeof deps.writer.refreshStaleSources !== 'function') return 0;
        const now = Date.now();
        if (!force && now - lastRefreshAt < REFRESH_INTERVAL_MS) return 0;
        lastRefreshAt = now;
        try { return deps.writer.refreshStaleSources() ?? 0; }
        catch { return 0; }
    }

    /** 续命（Q-4）：每 source 每日最多写一次；0 结果不续；失败静默。 */
    function touchAccessed(labels) {
        if (!labels || labels.length === 0) return 0;
        const now = new Date().toISOString();
        let wrote = 0;
        for (const label of labels) {
            try {
                // 条件里带"今天还没写过" —— 这就是每日节流（P-03 实测降 94% 写入）
                const today = now.slice(0, 10);
                const info = q.touch.run(now, label, today);
                wrote += info.changes;
            }
            catch { /* 续命失败不影响查询 */ }
        }
        return wrote;
    }

    function proximityFns() { return { findAllPositions, findMinSpan, countAdjacentPairs }; }

    return {
        search, searchPorter, searchTrigram, searchGram, fuzzyCorrect, touchAccessed, proximityFns,
        /** M-5 Step0 强制刷新（诊断/测试用；正常查询走 60s 节流版）。 */
        refreshStaleSources: (force = true) => maybeRefreshStaleSources(force),
        getSourceMeta: (label) => {
            const r = q.meta.get(label);
            if (!r) return null;
            return {
                label: r.label, chunkCount: r.chunk_count, codeChunkCount: r.code_chunk_count,
                indexedAt: r.indexed_at, filePath: r.file_path ?? null,
                contentHash: r.content_hash ?? null, accessedTs: r.accessed_ts ?? null,
            };
        },
        listSources: () => q.listSources.all(),
        /** label → sourceId（pin 需要；sourceId 才是真 ID，rowid 不是对外 ID）。 */
        getSourceIdByLabel: (label) => q.idByLabel.get(label)?.id ?? null,
        getIndexState: () => {
            const r = q.state.get();
            return {
                totalChunks: r.total_chunks ?? 0,
                totalSources: r.total_sources ?? 0,
                lastIndexedAt: r.last_indexed_at ?? undefined,
                // R13：写入账本（SUM(sources.chunk_count)）。与 totalChunks 不等 = 有漂移，
                // 供 op:stats / doctor 对账用，不参与"库里有多少块"的对外口径。
                totalChunksBilled: r.billed_chunks ?? 0,
                // Q-1 明写要补 maxUserVersion（引擎认知的最高 user_version）。
                maxUserVersion: sqlContract.SCHEMA_VERSION,
            };
        },
        getChunksBySource: (sourceId) => q.chunksBySource.all(sourceId).map((r) => ({
            title: r.title, content: r.content, source: r.label, rank: 0, contentType: r.content_type,
        })),
        getStats: () => {
            const r = q.stats.get();
            // M-7 明写要加三项：user_version / wal_bytes / accessed_today。
            //   accessed_today = 当日真续命行数（每日节流是否生效的遥测，T-5 靠它验）。
            let userVersion = 0;
            let walBytes = 0;
            let accessedToday = 0;
            try { userVersion = db.prepare('PRAGMA user_version').get().user_version ?? 0; } catch { /* 忽略 */ }
            try {
                const walPath = deps.dbPath ? `${deps.dbPath}-wal` : null;
                if (walPath) walBytes = fs.statSync(walPath).size;
            }
            catch { /* 没有 WAL 文件 = 0 */ }
            try {
                accessedToday = db.prepare("SELECT COUNT(*) AS c FROM sources WHERE date(accessed_ts) = date('now')").get().c ?? 0;
            }
            catch { /* 忽略 */ }
            return {
                sources: r?.sources ?? 0,
                chunks: r?.chunks ?? 0,
                codeChunks: r?.codeChunks ?? 0,
                user_version: userVersion,
                wal_bytes: walBytes,
                accessed_today: accessedToday,
            };
        },
        /** 源级区分度词（vocabulary 真表存在的第二个理由，P-05）。 */
        getDistinctiveTerms: (sourceId, maxTerms = 40) => {
            const st = q.chunkCountFor.get(sourceId);
            if (!st || st.chunk_count < 3) return [];
            const total = st.chunk_count;
            const docFreq = new Map();
            for (const row of q.distinct.iterate(sourceId)) {
                const words = new Set(String(row.content).toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
                    .filter((w) => w.length >= 3 && !tokenize.STOPWORDS.has(w)));
                for (const w of words) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
            }
            return Array.from(docFreq.entries())
                .filter(([, c]) => c >= 2 && c <= Math.max(3, Math.ceil(total * 0.4)))
                .map(([w, c]) => ({ word: w, score: Math.log(total / c) + Math.min(w.length / 20, 0.5) + (/[_]/.test(w) ? 1.5 : (w.length >= 12 ? 0.8 : 0)) }))
                .sort((a, b) => b.score - a.score).slice(0, maxTerms).map((s) => s.word);
        },
        _rrfK: RRF_K,
        _bm25Weights: sqlContract.BM25_WEIGHTS,
    };
}

function BM25_COLUMNS_MAP() { return sqlContract.BM25_COLUMNS; }

export function init(ctx) { ctx.readerFactory = createReader; }
