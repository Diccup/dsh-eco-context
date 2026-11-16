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
 * libs/select.js — intent 选块（2.0 `b05-index/index/select.ts` 的自有移植）
 *
 * 干什么：一份大输出整块入库后，按 intent 的命中分数在**预算内挑整块**拼回文本。
 *        原则「no cut without index」：不许把截断当丢弃 —— 挑不上的块永远在库里。
 * 为什么这样：14-tools 的 run 分支拿到超大输出时，模型只想要 intent 说的那部分；
 *            给整份烧上下文，给截断丢信息，给定位符最省（2.0 ADR-0016 裁决）。
 * 边界：纯函数。不查库、不写库、不认识 ctx；输入是已取出的块行 + 已算好的分数。
 *
 * 对应需求：02-清单 §3.2 沙箱归一 P3；2.0 D-M2-6。
 */

/** 按码点截到 ≤ maxBytes（UTF-8 不劈半字；与 13-sandbox/truncate 同语义，这里对整段成品用）。 */
export function capBytes(text, maxBytes) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return { text, cut: false, fullBytes: buf.length };
    // 逐码点回退：utf8 序列首字节 0b10xxxxxx 是续接字节，避开它们即不劈字
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
    return { text: buf.subarray(0, end).toString('utf8'), cut: true, fullBytes: buf.length };
}

/** 「还有更多」指针行：告诉模型去哪把剩下的捞回来。 */
export function moreLine(intent, label, hiddenCount) {
    return `…（intent "${intent}" 预算内只放下这些；该 source 还有 ${hiddenCount} 块没显示 —— 用 ctx({op:"recall",queries:[…],source:"${label}"}) 换词再取）`;
}

/**
 * budgeted greedy 选整块（2.0 ADR-0016 语义）：
 *   · 按分数降序（同分按输入序 = 新块在前，调用方保证）；
 *   · 整块进预算，放不下的**跳过但继续试更小的**（不许一断全断）；
 *   · 至少放一块：第一名超预算也给它（截它，截出的部分仍是信息）。
 *
 * @param {Array<{title?:string, content:string}>} rows 已按分数排好序的块
 * @param {number} budgetBytes 正文预算（不含指针行；指针行归调用方拼，它才知道 intent/label）
 * @returns {{ text:string, picked:number, hidden:number, skippedForSize:number }}
 */
export function selectChunks(rows, budgetBytes) {
    const parts = [];
    let used = 0;
    let skippedForSize = 0;
    for (const row of rows) {
        const body = `${row.title ? `## ${row.title}\n` : ''}${row.content}`;
        const size = Buffer.byteLength(body, 'utf8');
        if (used + size > budgetBytes) {
            if (parts.length === 0) {
                // 一块都放不下：截第一块，信息优先于体积红线
                const c = capBytes(body, budgetBytes);
                return { text: c.text, picked: 1, hidden: rows.length - 1, skippedForSize: 0 };
            }
            skippedForSize += 1;
            continue;
        }
        parts.push(body);
        used += size;
    }
    return {
        text: parts.join('\n\n'),
        picked: parts.length,
        hidden: rows.length - parts.length,
        skippedForSize,
    };
}
