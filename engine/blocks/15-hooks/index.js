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
 * 15-hooks — DSH 侧钩子面（压缩批次落库、归档分层、道 B 触发点）
 *
 * 干什么：把"压缩发生了什么"变成库里的东西：
 *   ① 压缩批次落库：一次压缩的归档文本写成临时库一个 source（label 带批次号）
 *   ② 归档分层：constraint / finding / narrative 三层（库的主体内容 78.5% 是这个）
 *   ③ 道 B 触发点：压完立刻调 10-recall 的 recallCompacted
 * 为什么这样：实测压缩后模型 50 次里 0 次主动去查自己丢了什么 → 必须由钩子推。
 * 边界：**不监听 DSH 事件**（那是桥侧的事，D1 判据）；这里只提供"被调用时做什么"的纯函数。
 *
 * ★★ 2026-11-14（项目 07）：`onWorkStart`（道 A 的引擎侧触发点）**整件摘除**。
 *   说明：「把道A去掉，不要道A推送了」。它在生产上**本来就零调用方**
 *   （平台层用的是 `ours/recall-hints.js`，不是这里），留着只是一个"看起来还有道 A"的假门面。
 *   历史留档（原实现，07-BACKUP\engine\blocks\15-hooks\index.js:65-72）：
 *     function onWorkStart(p) {
 *         if (!recall) return { hints: [], text: '' };
 *         return recall.recallHints(p?.prompt ?? '', {});
 *     }
 */

import { err } from '../../libs/err.js';

export const NAME = 'hooks';
export const INVARIANTS = [
    '不监听宿主事件（监听在桥侧），本块只做"被调用时做什么"',
    '归档三层：constraint/finding/narrative，缺省落 narrative',
    '道 B 触发在压缩之后，失败不阻断压缩结果返回',
    '同一批次重复落库 = 覆盖（by-label 语义）',
];

/** 三层标签（与 1.2.2 ours/precompact.js 同义，别改字面量）。 */
export const LAYERS = Object.freeze(['constraint', 'finding', 'narrative']);

/**
 * @param {object} deps
 * @param {object} deps.writer
 * @param {object} deps.recall
 */
export function createHooks(deps) {
    const { writer, recall } = deps;

    /**
     * 归档一次压缩批次。
     * @param {{batchLabel:string, text:string, sessionId?:string, layer?:string}} batch
     */
    function archiveBatch(batch) {
        if (!writer) throw new Error('15-hooks: 缺 writer');
        const { batchLabel, text, sessionId, layer } = batch ?? {};
        if (!batchLabel) throw err('NO_INPUT', { reason: 'archiveBatch 需要 batchLabel' });
        const lay = LAYERS.includes(layer) ? layer : 'narrative';
        // label 带层与批次号：同一批次重复归档 = 覆盖（by-label 语义）
        const label = `compact:${lay}:${batchLabel}`;
        const r = writer.writePlainText(String(text ?? ''), label, 20, { sessionId });
        return { label, layer: lay, totalChunks: r.totalChunks, sourceId: r.sourceId };
    }

    /**
     * 压缩完成 → 落库 + 出道 B 回放。
     * @param {{batchLabel:string, recapCard:string, prompt:string, text:string, sessionId?:string}} p
     */
    function onCompacted(p) {
        const out = { archived: null, playback: null, errors: [] };
        try {
            out.archived = archiveBatch({ batchLabel: p?.batchLabel, text: p?.text, sessionId: p?.sessionId });
        }
        catch (e) { out.errors.push(`archive: ${e.message}`); }
        try {
            if (recall) out.playback = recall.recallCompacted(p?.prompt ?? '', p?.recapCard ?? '', {});
        }
        catch (e) { out.errors.push(`recallCompacted: ${e.message}`); }   // 道 B 失败不阻断压缩
        return out;
    }

    /**
     * ~~道 A 触发点：模型开始干活时看一眼旧经验~~
     *
     * ★★ 2026-11-14（项目 07）：**整段删除**（原 L65-72）。道 A 全链退役，见文件头。
     *   原实现留档（07-BACKUP\engine\blocks\15-hooks\index.js:65-72）：
     *     function onWorkStart(p) {
     *         if (!recall) return { hints: [], text: '' };
     *         return recall.recallHints(p?.prompt ?? '', {});
     *     }
     */

    /** 从归档文本里猜层（约束性句子 vs 发现 vs 过程叙述）—— 纯启发式，宁可落 narrative。 */
    function classifyLayer(text) {
        const s = String(text ?? '');
        if (/必须|不许|只能|禁止|红线/.test(s)) return 'constraint';
        if (/发现|结论|实测|根因/.test(s)) return 'finding';
        return 'narrative';
    }

    return { archiveBatch, onCompacted, classifyLayer, LAYERS };
}

export function init(ctx) { ctx.hooksFactory = createHooks; }
