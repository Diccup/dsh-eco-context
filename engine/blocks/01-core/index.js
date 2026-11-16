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
 * 01-core — 契约与常量（kind: contract，deps: 无）
 *
 * 干什么：放整个引擎的"共同事实"：默认值、12 个执行语言、临时脚本扩展名、
 *        以及 S-2 `user_version` 的唯一判据函数 `userVersionState()`。
 * 为什么这样：这些值 1.2.2 散在 11 个文件里（OPTIMIZE_EVERY 写死在 store.js、
 *            SCRIPT_EXT 写死在 executor.js、user_version 判定写死在迁移里）。
 *            2.0 把它们集中在 b00；我们照做 —— 一块只放契约，不放任何实现。
 * 边界：不许 import 任何别的块（D2 静态扫描）；本块只依赖 libs/err.js 与 libs/sql.js。
 *
 * 对应需求：S-2（v1 定稿 / v0 有表拒迁 / v>认知只读）
 */

import { SCHEMA_VERSION } from '../../libs/sql.js';

/** 块名（registry 登记用，必须叫 core）。 */
export const NAME = 'core';

/**
 * 全引擎默认值。每个值都是 number —— selftest 会逐条断言，
 * 因为下游块（05/08/10/11/12）直接拿这些数字当闸门，改一个就是一条行为变更。
 *
 * ★ 2026-11-14（项目 07）：`HINT_MAX_BYTES`（道 A 单条 512B）**已删除** ——
 *   道 A 全链退役（说明：「把道A去掉，不要道A推送了」）。留一个没人读的常量
 *   会让 selftest 的"常量清单"继续证明一个不存在的功能还存在。
 */
export const DEFAULTS = Object.freeze({
    MAX_CHUNK_BYTES: 4096, // 05-analyze：单块字节上限
    OPTIMIZE_EVERY: 50, // 08-writer：每 50 次插入做一次 FTS5 optimize
    RETENTION_DAYS: 14, // 12-lifecycle：临时库删线
    MEMORY_MAX_BYTES: 65536, // 11-memory：长久库单行 64KB 体积闸（P-14）
    RECAP_MAX_BYTES: 2048, // 10-recall 道 B：recap 卡预算
    RRF_K: 60, // 09-reader：RRF 平滑常数
    SEARCH_P95_MS: 15, // 09-reader：单条查询延迟红线（Q-5 / P-06）
    TOOL_TIMEOUT_MS: 600000, // 13-sandbox：工具级超时（10 分钟）
});

/** 12 个执行语言，一个不裁（13-sandbox 探测、14-tools schema enum 都读这里）。 */
export const EXEC_LANGUAGES = Object.freeze([
    'javascript',
    'typescript',
    'python',
    'shell',
    'ruby',
    'go',
    'rust',
    'php',
    'perl',
    'r',
    'elixir',
    'csharp',
]);

/**
 * 临时脚本扩展名：从 ref/current-engine/executor.js L14-27 原样搬，一个不改。
 * Windows 下 shell 走的是"无扩展名"这条路（executor 里另判），这里只留基表。
 */
export const SCRIPT_EXT = Object.freeze({
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    shell: 'sh',
    ruby: 'rb',
    go: 'go',
    rust: 'rs',
    php: 'php',
    perl: 'pl',
    r: 'R',
    elixir: 'exs',
    csharp: 'csx',
});

/** `userVersionState()` 的四个返回态（调用方按态分派，不许自己比数字）。 */
export const SCHEMA_STATES = Object.freeze({
    READY: 'ready',
    REFUSE: 'refuse-v0-with-tables',
    FRESH: 'fresh',
    READ_ONLY: 'read-only',
});

/**
 * S-2 的唯一判据：给定库里的 `user_version` 与表数量，返回四态之一。
 *
 * | 输入 | 返回 | 含义 |
 * |---|---|---|
 * | v === SCHEMA_VERSION（现为 2） | `ready` | 定稿结构，直通 |
 * | v === 0 且有表 | `refuse-v0-with-tables` | 老库 → **拒迁**（不许静默重建=不许静默删库） |
 * | v === 0 且空库 | `fresh` | 正常建表 |
 * | v > SCHEMA_VERSION | `read-only` | 认知外的版本，只读报警 |
 *
 * v < 0 不是 SQLite 能给出的值（user_version 是无符号），出现即数据异常 → 也走只读。
 *
 * ★ 2026-11-04：这个判据本身没错，错的是 `SCHEMA_VERSION` 没跟着迁移脚本一起升
 *   （脚本升到 2、常量留 1）→ 真库被判 read-only → 12 个 op 全 UNKNOWN_OP。
 *   注意：v1 现在**不是** `ready`，而是落到 `read-only` —— 这是有意的：
 *   v1 的 tokenizer/trigram 形态与 v2 不同，直通会静默用错结构；
 *   要升 v1 库得走 `scripts/migrate-old-library.mjs`（v1→v2 会重建索引）。
 *
 * @param {number} userVersion pragma user_version 的当前值
 * @param {number} tableCount sqlite_master 里 type='table' 的行数
 * @returns {'ready'|'refuse-v0-with-tables'|'fresh'|'read-only'}
 */
export function userVersionState(userVersion, tableCount) {
    // 严格类型：不做 Number() 转换。'1' / true / null 混进来一律 throw ——
    // 这条判据决定"建表 / 拒迁 / 只读"，猜错一次的代价是删库，绝不接受弱类型入参。
    if (typeof userVersion !== 'number' || typeof tableCount !== 'number' ||
        !Number.isInteger(userVersion) || !Number.isInteger(tableCount)) {
        throw new TypeError(
            `core.userVersionState(): 入参必须是整数（不自动转型），收到 userVersion=${JSON.stringify(userVersion)} (${typeof userVersion}) tableCount=${JSON.stringify(tableCount)} (${typeof tableCount})`,
        );
    }
    const v = userVersion;
    const n = tableCount;
    if (v === SCHEMA_VERSION) return SCHEMA_STATES.READY;
    if (v === 0) return n > 0 ? SCHEMA_STATES.REFUSE : SCHEMA_STATES.FRESH;
    // v > 1（或异常负值）：认知外的结构，永不猜、永不写。
    return SCHEMA_STATES.READ_ONLY;
}

/** 契约块：没有运行时状态，init 只把默认值挂进 ctx 供后续块取用。 */
export async function init(ctx) {
    ctx.defaults = DEFAULTS;
    ctx.languages = EXEC_LANGUAGES;
    return { name: NAME, ready: true };
}

/** 本块不变量（registry 记进 meta，供 verify/ 的门脚本按名引用）。 */
export const INVARIANTS = Object.freeze([
    'DEFAULTS 每个值都是有限正数',
    'EXEC_LANGUAGES 恒为 12 个且不重复',
    'SCRIPT_EXT 覆盖 EXEC_LANGUAGES 全部 12 个键',
    'userVersionState 四态互斥且覆盖 v<0 / v=0 / v=1 / v>1',
]);
