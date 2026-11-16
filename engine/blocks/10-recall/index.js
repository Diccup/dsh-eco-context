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
 * 10-recall — 双库合并与压缩回放（原「两道推送」，2026-11-14 起只剩道 B）
 *
 * 干什么：① 席位制：临时库结果 + 长久库结果按席位合并（长久库 ≤2 席先占）；
 *        ② 道 B `recallCompacted`：刚压缩完把 recap 卡 + ≤2 整块 + 指针推回去（~2048B）。
 *
 * 为什么这样：实测压缩后模型 50 次里 0 次会主动去查自己丢了什么（01 §十二），
 *            所以 B 是"被迫回想"。
 *
 * 边界：只做"选哪几条 + 怎么渲染成 ≤N 字节"，不查库（查库归 09-reader）、不写库（写归 08-writer）。
 *
 * ★★ 2026-11-14（项目 07）：**道 A `recallHints` 整件摘除**（说明：「把道A去掉，不要道A推送了」）。
 *
 *   删掉的东西（一件不剩）：
 *     · `hints` 渲染函数 `recallHints()`（原 L56-102）
 *     · 常量 `HINT_MAX_BYTES = 512`（原 L25）
 *     · 去重池 `seenA`（原 L38）
 *     · `hintShownCount` 计数器（原 L40）
 *     · 返回值里的 `recallHints`、`_state()` 的 `seenA`/`hintShownCount`、`_limits` 的 `HINT_MAX_BYTES`
 *
 *   为什么连 `seenA` 一起删：它是**道 A 专用的去重池**。道 A 不推了，它恒空；
 *   留一个恒空的 Set 在 `_state()` 里，`op:stats` 会继续报 `seenA: 0` ——
 *   下一个人会以为"道 A 还在，只是没命中"，从而去修一个已经不存在的东西。
 *
 *   ★ T-11 的结论要**保留**（它是本轮之前就成立的事实，不是道 A 的私有物）：
 *     两池独立 —— 道 A 推过的内容，压缩归档后道 B 仍能带出来。
 *     现在道 A 不在了，这条自动成立（没有第二个池可以串味）。
 *     但**不许**因此把 `seenB` 也删掉：它守的是"同一块不重复回放"，与道 A 无关。
 *
 *   历史留档（道 A 在位时的两条口径，别丢）：
 *     · 道 A 的**生产实现**从来不是本文件 —— 是 `ours/recall-hints.js`（975 行，挂宿主
 *       `tools/pre-execute`，按「prompt ∪ 模型调用信号」打分）。本文件的 `recallHints`
 *       在生产上**零调用方**（只有 15-hooks 与自己的 selftest 用）。
 *     · 2026-11-06 S9.44 就是靠这个事实抓到的：`op:stats` 读本文件 `_state()`，
 *       于是 seenA 恒 0 = 那一行数是死的。
 */

export const NAME = 'recall';
export const INVARIANTS = [
    '道 B 必含 recap 卡 + ≤2 整块 + 指针，预算 ~2048B',
    '长久库席位 ≤2，先占',
    'seenB 守「同一块不重复回放」（与已退役的道 A 无关，不许顺手删）',
];

const RECAP_MAX_BYTES = 2048;

/**
 * @param {object} deps
 * @param {object} deps.reader   09-reader（临时库检索）
 * @param {object} deps.memory   11-memory（长久库读面）
 */
export function createRecall(deps) {
    const { reader, memory } = deps;
    if (!reader) throw new Error('10-recall: 缺 reader');

    // ★ 道 B 的去重池：本对话已回过放的块身份（`source::title`）
    const seenB = new Set();

    /** 按字节预算截断（不劈码点）。 */
    function capBytes(s, max) {
        if (Buffer.byteLength(s) <= max) return s;
        let out = '';
        let bytes = 0;
        for (const ch of s) {
            const b = Buffer.byteLength(ch);
            if (bytes + b > max) break;
            out += ch;
            bytes += b;
        }
        return out;
    }

    /**
     * 道 B：压缩后回放。
     * @param {string} prompt         压缩后的新提示（用于选最相关块）
     * @param {string} recapCard      压缩器写的几十字小卡（**必含**）
     * @param {{limit?:number, store?:string}} [opts]
     */
    function recallCompacted(prompt, recapCard, opts = {}) {
        const cap = '【压缩回放】\n' + capBytes(String(recapCard ?? '(无卡片)').trim(), 600);
        const blocks = [];
        let pointers = [];

        // 选 ≤2 整块：临时库查 prompt
        if (prompt && reader) {
            try {
                const hits = reader.search({ query: prompt, limit: 2 + (opts.limit ?? 0) });
                for (const h of hits) {
                    const identity = `${h.source}::${h.title}`;
                    if (seenB.has(identity)) continue;
                    seenB.add(identity);
                    blocks.push(h);
                    if (blocks.length >= (opts.limit ?? 2)) break;
                }
            }
            catch { /* 回放失败不影响压缩后继续干活 */ }
        }

        // 指针：告诉模型"还有哪些没带出来"
        if (prompt) {
            try {
                const more = reader.search({ query: prompt, limit: 6 });
                pointers = more
                    .filter((m) => !blocks.some((b) => b.source === m.source && b.title === m.title))
                    .slice(0, 3)
                    .map((m) => `${m.source} · ${m.title}`);
            }
            catch { /* 忽略 */ }
        }

        const parts = [cap];
        for (const b of blocks) parts.push(`───── ${b.source} · ${b.title}\n${b.content}`);
        if (pointers.length > 0) parts.push('还有：' + pointers.join(' / '));
        const text = capBytes(parts.join('\n\n'), RECAP_MAX_BYTES);
        return {
            text,
            bytes: Buffer.byteLength(text),
            blocks: blocks.map((b) => ({ source: b.source, title: b.title, identity: `${b.source}::${b.title}` })),
            pointers,
            hasRecapCard: Boolean(recapCard),
        };
    }

    /** 席位制合并：临时库结果 + 长久库结果，长久库先占 ≤2 席。 */
    function mergeWithMemory(tempResults, memoryRows, opts = {}) {
        const memSeats = opts.memorySeats ?? 2;
        const memorySlots = (memoryRows ?? []).slice(0, memSeats).map((m) => ({
            title: m.title,
            content: m.content ?? '',
            source: m.label,
            // ★ R-v3（2026-11-04 全功能核验③）：原来这里没映射 `category`，
            //   14-tools 渲染长久库段落用的是 `(${m.category})` —— 于是每条都印成
            //   `### [长久] 标题  (undefined)`。分类是长久库的**唯一路标**
            //   （<主题>/<部分>[/<类型>]），丢了模型就没法按领域挑线索。
            //   memoryRows 来自 11-memory 的 list()，字段名就是 category。
            category: m.category ?? '',
            rank: 0,
            contentType: 'prose',
            highlighted: '',
            timestamp: undefined,
            sessionId: '',
            store: 'memory',
        }));
        const tempSlots = (tempResults ?? []).map((r) => ({ ...r, store: 'temp' }));
        return [...memorySlots, ...tempSlots];
    }

    return {
        recallCompacted, mergeWithMemory,
        /** 供 ctx_stats / 自验读（道 B 回放计数）。★ `seenA` 随道 A 一起退役，不再谎报 0。 */
        _state: () => ({ seenB: seenB.size }),
        _reset: () => { seenB.clear(); },
        _limits: { RECAP_MAX_BYTES },
    };
}

export function init(ctx) { ctx.recallFactory = createRecall; }
