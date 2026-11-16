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
 * libs/url-guard.js — 网页入口 URL 的安全闸（2.0 `b04-sandbox/fetch.ts` 的自有裁剪版）
 *
 * 干什么：op:index {url} / op:search {url} 把 URL 交给抓取实现**之前**过一遍闸：
 *        只放 http/https；字面内网地址、环回、链路本地（169.254 = 云 metadata）、
 *        保留主机名（localhost/*.internal 等）一律拒。
 * 为什么这样：2.0 完整版带逐跳 DNS 检查（SSRF per hop）。本包真实抓取链是
 *        ours/web-search（curl_cffi/浏览器指纹，fp 回退是需求方要保的核心增强），
 *        引擎拿不到它每一跳的解析结果 —— 入口字面检查能拦掉最危险的直球
 *        （`http://169.254.169.254/`、`http://127.0.0.1:port`、`file://`），
 *        DNS 指向内网的域名跳不过，这是**已知边界**，注释在此不许假装全防。
 * 边界：纯同步函数，不解析 DNS、不发请求。
 */

import { err } from './err.js';

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 是否内网/环回/链路本地/未指定。 */
function isPrivateV4(a, b) {
    if (a === 127 || a === 10 || a === 0) return true;          // 环回 / 私网A / 未指定
    if (a === 169 && b === 254) return true;                    // 链路本地（云 metadata！）
    if (a === 172 && b >= 16 && b <= 31) return true;           // 私网B
    if (a === 192 && b === 168) return true;                    // 私网C
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT (RFC6598)
    if (a === 198 && (b === 18 || b === 19)) return true;       // benchmark
    return false;
}

/** IPv6 是否环回/未指定/链路本地/唯一本地（fc00::/7）或映射 v4 的内网。 */
function isPrivateV6(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80')) return true;                       // 链路本地
    if (h.startsWith('fc') || h.startsWith('fd')) return true;   // ULA fc00::/7
    const mapped = h.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (mapped && isPrivateV4(Number(mapped[1]), Number(mapped[2]))) return true;
    return false;
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata\.google.internal|wpad|.*\.home.arpa)$/i;

/**
 * 判一个 URL 能不能抓。安全 → 返回规范化的 URL 字符串；危险 → 抛 err('URL_BLOCKED')。
 * @param {string} raw
 * @returns {string} 规范化后的 URL
 */
export function assertSafeUrl(raw) {
    let u;
    try {
        u = new URL(String(raw));
    }
    catch {
        throw err('NO_INPUT', { reason: `url 无法解析：${String(raw).slice(0, 80)}` });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw err('URL_BLOCKED', { url: u.href, reason: `协议 ${u.protocol} 不许（只放 http/https）` });
    }
    const host = u.hostname.toLowerCase();
    const v4 = V4.exec(host);
    if (v4 && isPrivateV4(Number(v4[1]), Number(v4[2]))) {
        throw err('URL_BLOCKED', { url: u.href, reason: '内网/环回/链路本地地址（SSRF 闸）' });
    }
    if (host.includes(':') && isPrivateV6(host)) {
        throw err('URL_BLOCKED', { url: u.href, reason: '内网 IPv6 地址（SSRF 闸）' });
    }
    if (BLOCKED_HOSTS.test(host)) {
        throw err('URL_BLOCKED', { url: u.href, reason: '保留主机名（localhost/.internal/.local/…）' });
    }
    if (u.username || u.password) {
        throw err('URL_BLOCKED', { url: u.href, reason: 'URL 里带凭据（ userinfo ）：不许' });
    }
    return u.href;
}
