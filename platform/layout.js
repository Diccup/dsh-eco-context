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
 * platform/layout.js — 积木⓪：布局探测（同一份平台适配代码，两种目录形态，零路径改写）。
 *
 * 归属：**自有**。存在的唯一理由：平台适配代码必须能**完整不改**地同时活在开发区与
 * 发布包里，否则每次生成发布包都要重写路径，一改就漂移（ws-transport 曾因此分叉过）。
 *
 * 硬约定（两种形态下 `platform/` 与 `ours/` 永远是**兄弟目录**，`engine/` 永远是它们的兄弟）：
 *
 *   开发区    Work\dsh-context-mode\
 *               ├ ours/          ← 自有增强模块
 *               ├ platform/      ← 平台适配积木（本目录），import '../ours/x.js'
 *               ├ engine/        ← 平台无关引擎（17 块积木）
 *               ├ skills/
 *
 *   发布包    node_modules\dsh-eco-context\
 *               ├ ours/  platform/  engine/  skills/
 *
 *   1.0.0 没有 vendor bundle、没有 upstream/ —— 引擎在 engine/，进程内加载。
 *   ★ 2026-11-04：modes/ 随模式系统退役（原版转接整条删除），本处不再探测。
 *
 * 于是静态 import 路径两边一致，只有"数据目录/引擎位置"不同 → 由此处统一给出。
 * 探测靠**特征文件存在性**，不靠约定，找不到就抛：宁可不装，也不静默走错路径。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本目录（platform/）。 */
export const PLATFORM_DIR = dirname(fileURLToPath(import.meta.url));

/** 候选：技能目录。 */
const SKILLS_CANDIDATES = [join('..', 'skills')];
/** 候选：自有引擎目录（1.0.0 唯一的引擎位）。 */
const ENGINE_CANDIDATES = [
    join('..', 'engine'),
    join('..', '..', 'engine'),
];

/**
 * 第一个存在的候选（相对 platformDir）。
 * @param {string} platformDir
 * @param {string[]} candidates
 * @param {string} label
 * @returns {string}
 */
function firstExisting(platformDir, candidates, label) {
    for (const rel of candidates) {
        const abs = join(platformDir, rel);
        if (existsSync(abs))
            return abs;
    }
    throw new Error(`dsh-eco-context: ${label} not found; looked for ${candidates.map(rel => join(platformDir, rel)).join(' | ')}`);
}

/**
 * 第一个存在的候选，全都没有就返回 undefined（用于"可选"项）。
 * @param {string} platformDir
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function firstOptional(platformDir, candidates) {
    for (const rel of candidates) {
        const abs = join(platformDir, rel);
        if (existsSync(abs))
            return abs;
    }
    return undefined;
}

/**
 * 探测一次布局（显式环境变量可覆盖引擎位置，供外测用）。
 *
 * ★ 1.0.0：`serverBundle` **整个删掉**。
 *   它是 1.2.2 子进程时代的概念（"起 node <bundle>"），1.0.0 只有进程内引擎，
 *   包里也没有 vendor bundle。留着这个键只会让 README / 配置 / 报错文案
 *   继续指向一条不存在的东西。
 *
 *   `engineRoot` 由 `engine-client.js::resolveEngineRoot()` 落地（那里有存在性判据），
 *   这里的 `firstOptional` 只做粗探；环境变量 `DSH_CTX_ENGINE_ROOT` 仍可覆盖。
 *
 * @param {Record<string, string>} [env]
 * @param {string} [platformDir]
 * @returns {{ platformDir: string, skillsDir: string, engineRoot: string | undefined }}
 */
export function detectLayout(env = process.env, platformDir = PLATFORM_DIR) {
    return {
        platformDir,
        skillsDir: firstExisting(platformDir, SKILLS_CANDIDATES, 'skills/ directory'),
        engineRoot: env.DSH_CTX_ENGINE_ROOT ?? firstOptional(platformDir, ENGINE_CANDIDATES),
    };
}

/** 进程级缓存（模块加载时算一次；布局在进程生命周期内不变）。 */
let cached;
/**
 * 取缓存布局。
 * @returns {ReturnType<typeof detectLayout>}
 */
export function layout() {
    if (cached === undefined)
        cached = detectLayout();
    return cached;
}
