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
 * 17-plugs — 算法插槽（横切层）
 *
 * 干什么：把"可换的算法"集中到一处 —— 三种槽：tokenize（cjk/porter/trigram）、
 *        chunk（heading/plain/json）、rank（rrf/mmr/proximity）。
 * 为什么这样：D8「可换可对比」要求同一批查询、同一个库，两个 rank 实现各跑一遍并出对比表，
 *            **换实现不改调用方一行**。所以槽必须有同形签名，靠 registry 传引用，不靠 import 具体文件。
 * 边界：**本块不许依赖任何实现块**（它是横切层，被 07/09 依赖）。槽里只放纯算法。
 */

export const NAME = 'plugs';
export const INVARIANTS = [
    '横切层：不依赖任何 impl 块，保证引擎可单测',
    '三种槽只有固定签名，不引入万能注册框架',
    '换实现 = 换一个 plugs 实现，调用方一行不改',
];

export const SLOT_KINDS = Object.freeze(['tokenize', 'chunk', 'rank']);

// ─────────────────────────────────────────────────────────
// rank 槽：同形签名 (candidates, opts) => orderedResults
// ─────────────────────────────────────────────────────────
/** RRF（Cormack et al. 2009）—— 主线默认。 */
export function rankRrf(lists, opts = {}) {
    const K = opts.k ?? 60;
    const limit = opts.limit ?? 10;
    const scoreMap = new Map();
    const keyOf = opts.keyOf ?? ((r) => `${r.source}::${r.title}`);
    for (const [name, rows] of lists) {
        for (const [i, r] of (rows ?? []).entries()) {
            const k = keyOf(r);
            const inc = 1 / (K + i + 1);
            const ex = scoreMap.get(k);
            if (ex) { ex.score += inc; ex.layers.push(name); }
            else scoreMap.set(k, { result: r, score: inc, layers: [name] });
        }
    }
    return Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ result, score, layers }) => ({ ...result, rank: -score, layers }));
}

/** MMR（多样性）—— 候选默认关（01 §八 ②：无 embedding 服务，MMR 只作 plugs 候选）。 */
export function rankMmr(candidates, opts = {}) {
    const lambda = opts.lambda ?? 0.7;
    const limit = opts.limit ?? 10;
    const sim = opts.similarity ?? ((a, b) => jaccard(a.title, b.title));
    const remaining = candidates.slice();
    const picked = [];
    while (picked.length < limit && remaining.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const rel = remaining[i].rank ?? 0;
            const maxSim = picked.length === 0 ? 0 : Math.max(...picked.map((p) => sim(remaining[i], p)));
            const score = (1 - lambda) * rel - lambda * maxSim;
            if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        picked.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }
    return picked;
}

/** proximity 重排（1.2.2 的三 boost 语义，另加 tier）。 */
export function rankProximity(results, opts = {}) {
    const terms = opts.terms ?? [];
    const limit = opts.limit ?? results.length;
    const tierWeight = opts.tierWeight ?? 0.15;
    return results.map((r) => {
        const titleLower = String(r.title).toLowerCase();
        const hits = terms.filter((t) => titleLower.includes(t)).length;
        const titleWeight = r.contentType === 'code' ? 0.6 : 0.3;
        const titleBoost = terms.length > 0 && hits > 0 ? titleWeight * (hits / terms.length) : 0;
        let prox = 0; let phrase = 0;
        if (terms.length >= 2) {
            const content = String(r.content).toLowerCase();
            const lists = terms.map((t) => positionsOf(content, t));
            if (!lists.some((l) => l.length === 0)) {
                prox = 1 / (1 + minSpan(lists) / Math.max(content.length, 1));
                phrase = 0.5 * Math.min(1, adjacentPairs(lists, terms) / 4);
            }
        }
        const tier = r.sessionId ? tierWeight : 0;
        return { r, boost: titleBoost + prox + phrase + tier };
    })
        .sort((a, b) => b.boost - a.boost || (a.r.rank ?? 0) - (b.r.rank ?? 0))
        .slice(0, limit)
        .map((x) => x.r);
}

function positionsOf(text, term) {
    const out = []; let i = text.indexOf(term);
    while (i !== -1) { out.push(i); i = text.indexOf(term, i + 1); }
    return out;
}
function minSpan(lists) {
    if (lists.length <= 1) return 0;
    const ptrs = new Array(lists.length).fill(0);
    let best = Infinity;
    while (true) {
        let lo = Infinity; let hi = -Infinity; let li = 0;
        for (let i = 0; i < lists.length; i++) {
            const v = lists[i][ptrs[i]];
            if (v < lo) { lo = v; li = i; }
            if (v > hi) hi = v;
        }
        if (hi - lo < best) best = hi - lo;
        ptrs[li]++;
        if (ptrs[li] >= lists[li].length) break;
    }
    return best;
}
function adjacentPairs(lists, terms, gap = 30) {
    if (lists.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < Math.min(lists.length, terms.length) - 1; i++) {
        const L = lists[i]; const R = lists[i + 1]; const len = terms[i].length;
        let j = 0;
        for (const p of L) {
            const minStart = p + len; const maxStart = minStart + gap;
            while (j < R.length && R[j] < minStart) j++;
            if (j < R.length && R[j] <= maxStart) { total++; j++; }
        }
    }
    return total;
}
function jaccard(a, b) {
    const sa = new Set(String(a ?? '').toLowerCase().split(/\s+/));
    const sb = new Set(String(b ?? '').toLowerCase().split(/\s+/));
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    const uni = sa.size + sb.size - inter;
    return uni === 0 ? 0 : inter / uni;
}

/** 槽注册表：`{rank: {name: fn}}`，09-reader 按名字取实现。 */
export function createSlots(impls = {}) {
    const slots = { tokenize: new Map(), chunk: new Map(), rank: new Map() };
    const def = { rank: { rrf: rankRrf, mmr: rankMmr, proximity: rankProximity } };
    for (const [kind, table] of Object.entries(def)) for (const [k, fn] of Object.entries(table)) slots[kind].set(k, fn);
    for (const [kind, table] of Object.entries(impls)) {
        if (!SLOT_KINDS.includes(kind)) throw new Error(`17-plugs: 未知槽 ${kind}`);
        for (const [k, fn] of Object.entries(table ?? {})) slots[kind].set(k, fn);
    }
    return {
        get: (kind, name) => {
            const fn = slots[kind]?.get(name);
            if (!fn) throw new Error(`17-plugs: 槽 ${kind} 没有实现 ${name}（可用：${[...(slots[kind]?.keys() ?? [])].join(',')}）`);
            return fn;
        },
        list: () => Object.fromEntries(Object.entries(slots).map(([k, m]) => [k, [...m.keys()]])),
        /** 对比表：同批查询、两个 rank 实现各跑一遍（G5b 的产出）。 */
        compare(generate, inputs, names = ['rrf', 'proximity'], opts = {}) {
            const table = names.map((name) => {
                const fn = this.get('rank', name);
                const t0 = performance.now();
                const out = inputs.map((input) => fn(input, opts));
                const ms = performance.now() - t0;
                return { impl: name, results: out, ms: Number(ms.toFixed(2)) };
            });
            return { generate, table };
        },
    };
}

export function init(ctx) {
    ctx.plugs = createSlots();
}
