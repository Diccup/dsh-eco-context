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
 * 13-sandbox/truncate.js — 按码点截断（不劈 CJK / emoji）
 *
 * 干什么：执行面收回来的一大坨 stdout/stderr 必须能安全压到字节上限里，
 *        且压完最后一个字符仍是**完整码点**（半个汉字/半个 emoji 会渲染成 U+FFFD）。
 * 为什么这样：移植自 `engine/ref/current-engine/truncate.js`（1.2.2 行为基线，只读）。
 *            原文件 142 行，这里逐条搬语义，只多导出一个 `byteSafePrefix` 供 selftest 直测。
 * 边界：纯函数，不碰文件、不碰进程。
 */

// ─────────────────────────────────────────────
// Internal: byte-safe prefix
// ─────────────────────────────────────────────
/**
 * 返回 `str` 的最长前缀，其 UTF-8 编码 ≤ `maxBytes` 字节。
 * 二分查找避免 O(n²) 扫描。`maxBytes <= 0` 时返回 ""，调用方永远不超预算。
 * 防 UTF-16 代理对被劈：若前缀恰好落在孤立高代理上，回退一个码元，
 * 保证结果能原样过 UTF-8 而不产生 U+FFFD。
 */
export function byteSafePrefix(str, maxBytes) {
    if (maxBytes <= 0)
        return "";
    if (Buffer.byteLength(str) <= maxBytes)
        return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (Buffer.byteLength(str.slice(0, mid)) <= maxBytes) {
            lo = mid;
        }
        else {
            hi = mid - 1;
        }
    }
    // 落在高低代理之间就回退，保证前缀结束在合法码点边界上。
    if (lo > 0) {
        const code = str.charCodeAt(lo - 1);
        if (code >= 0xd800 && code <= 0xdbff)
            lo -= 1;
    }
    return str.slice(0, lo);
}

// ─────────────────────────────────────────────
// Char-count prefix (UTF-16 surrogate-safe)
// ─────────────────────────────────────────────
/**
 * 返回 `str` 的最长前缀，长度 ≤ `maxChars` 个 UTF-16 码元；
 * 若会劈开代理对则回退一个码元。与 `byteSafePrefix` 的代理安全语义一致，
 * 但用字符预算而非字节预算。
 */
export function charSafePrefix(str, maxChars) {
    if (maxChars <= 0)
        return "";
    if (str.length <= maxChars)
        return str;
    let end = maxChars;
    const code = str.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return str.slice(0, end);
}

// ─────────────────────────────────────────────
// JSON truncation
// ─────────────────────────────────────────────
/**
 * 把值序列化成 JSON 再截到 `maxBytes` 字节。截断处按 UTF-8 安全边界切，
 * 并追加 "... [truncated]"。**截断后不保证是合法 JSON**，只适合展示/日志。
 * 返回值恒 ≤ `maxBytes` 字节；`maxBytes` 比标记还小时，标记自身也被按字节安全截断。
 */
export function truncateJSON(value, maxBytes, indent = 2) {
    const serialized = JSON.stringify(value, null, indent) ?? "null";
    if (Buffer.byteLength(serialized) <= maxBytes)
        return serialized;
    const marker = "... [truncated]";
    const markerBytes = Buffer.byteLength(marker);
    // 预算退化到装不下内容+标记：能塞多少标记就塞多少，仍守 `maxBytes`。
    if (maxBytes <= markerBytes)
        return byteSafePrefix(marker, maxBytes);
    return byteSafePrefix(serialized, maxBytes - markerBytes) + marker;
}

// ─────────────────────────────────────────────
// XML / HTML escaping
// ─────────────────────────────────────────────
/**
 * 转义五个 XML 保留字符，供安全嵌进 XML/HTML 属性或文本节点。
 */
export function escapeXML(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ─────────────────────────────────────────────
// maxBytes guard
// ─────────────────────────────────────────────
/**
 * `str` 不超 `maxBytes` 就原样返回；否则按字节安全切片并追加省略号。
 * 返回值恒 ≤ `maxBytes` 字节。
 */
export function capBytes(str, maxBytes) {
    if (Buffer.byteLength(str) <= maxBytes)
        return str;
    const marker = "...";
    const markerBytes = Buffer.byteLength(marker);
    if (maxBytes <= markerBytes)
        return byteSafePrefix(marker, maxBytes);
    return byteSafePrefix(str, maxBytes - markerBytes) + marker;
}

/**
 * 执行面专用：把一段输出压到 `maxBytes` 字节内，**不劈码点**。
 * 与 `capBytes` 的区别：这里不加省略号标记（stdout 是数据，加标记会污染返回值），
 * 只做纯前缀截断；`truncated` 由调用方据「原长 > 上限」判定。
 */
export function truncateOutput(text, maxBytes) {
    if (typeof text !== "string") return "";
    return byteSafePrefix(text, maxBytes);
}
