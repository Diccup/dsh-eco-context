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
 * libs/sql.js — SQL 表达式拼装（唯一允许的 SQL 字面量来源）
 *
 * 干什么：把"列序锁死"这条库硬约束变成代码。`bm25(表, 5.0, 1.0, 1.0)` 的第三个参数
 *        是按列序逐位对应的权重，漏一个参数 = 排序悄悄变、查不出（01-立项书 §十四 风险表）。
 * 为什么这样：1.2.2 里 12 条 SQL 各自写死了 `bm25(…,5.0,1.0)`，改一处漏一处；
 *            这里只出函数，所有块都调它，列序变了编译期就炸（断言 + selftest）。
 * 边界：不做 ORM、不拼用户输入（用户值一律走绑定参数 ?）；只拼"结构固定"的表达式。
 */

/**
 * 列序契约（S-1）。**改这个数组 = 改库结构 = 必须走迁移 + 重算全部索引**。
 *
 * ★ 两表列序**必须不同**（回源 `库重写最终定义.md` §1.2）：
 *   · `chunks`         = title, content, **script_ngrams**, 6×UNINDEXED   ← 加了一列
 *   · `chunks_trigram` = title, content, 6×UNINDEXED                     ← **不加列**
 *
 * 实现方第一版把 script_ngrams 也写进 trigram 表，导致同一份 gram 文本存两遍：
 *   重建库口径实测 3.19× → 3.63×（多耗 0.44×），**写放大因此超标**（T-7 抓到的）。
 *   库文档写完就说"表数量不变，只加一列"，这里必须照办。
 *   ★ 3.19× / 3.63× 都是**重建库口径**的数字；真实增量写入路径的写放大在 10× 量级。
 */
export const CHUNK_COLUMNS = Object.freeze({
    porter: ['title', 'content', 'script_ngrams', 'source_id', 'content_type', 'source_category', 'session_id', 'event_id', 'timestamp', 'accessed_ts'],
    trigram: ['title', 'content', 'source_id', 'content_type', 'source_category', 'session_id', 'event_id', 'timestamp', 'accessed_ts'],
});

/** 参与 bm25 的列（按顺序，权重逐位对应）。UNINDEXED 列不参与。 */
export const BM25_COLUMNS = Object.freeze({ chunks: ['title', 'content', 'script_ngrams'], chunks_trigram: ['title', 'content'] });
export const BM25_WEIGHTS = Object.freeze({ chunks: [5.0, 1.0, 1.0], chunks_trigram: [5.0, 1.0] });

/** highlight 的列下标：1 = content（FTS5 0-based）。两表都是 1。**这一条不许算**：写死。 */
export const HIGHLIGHT_COLUMN_INDEX = 1;

/**
 * 生成 `bm25(tbl, w0, w1, …)` —— **权重个数必须等于该表的索引列数**，少一个就 throw。
 * 这是刻意的编译期护栏：漏参数 = 该列吃默认权重 = 排序悄悄变（S-1）。
 * @param {'chunks'|'chunks_trigram'} tbl
 */
export function bm25(tbl) {
    const weights = BM25_WEIGHTS[tbl];
    if (!weights) throw new Error(`sql.bm25(): 未知表 ${tbl}（只认 chunks / chunks_trigram）`);
    const args = weights.map((w) => Number(w).toFixed(1)).join(', ');
    return `bm25(${tbl}, ${args})`;
}

/**
 * 生成 highlight。FTS5 里 highlight 的列下标按**建表列序** 0-based 数，
 * content 在两表里都是第 2 列 → 下标 1。
 */
export function highlight(tbl) {
    return `highlight(${tbl}, ${HIGHLIGHT_COLUMN_INDEX}, char(2), char(3))`;
}

/** 建表 DDL：索引列由 CHUNK_COLUMNS 决定（chunks 多 script_ngrams，trigram 没有）。 */
export function chunkTableDDL(tblName, tokenizer) {
    const cols = CHUNK_COLUMNS[tblName === 'chunks' ? 'porter' : 'trigram'];
    if (!cols) throw new Error(`sql.chunkTableDDL(): 未知表 ${tblName}`);
    const indexed = new Set(['title', 'content', 'script_ngrams']);
    const lines = cols.map((c) => (indexed.has(c) ? `  ${c},` : `  ${c} UNINDEXED,`));
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tblName} USING fts5(\n${lines.join('\n')}\n  tokenize='${tokenizer}'\n)`;
}

/** 四表 DDL（sources 8 列 = 7 现有 + accessed_ts；vocabulary 真表）。 */
export const SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  code_chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  file_path TEXT,
  content_hash TEXT,
  accessed_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
CREATE TABLE IF NOT EXISTS vocabulary (word TEXT PRIMARY KEY);
`;

/**
 * ★ R15（2026-11-04 测试汇总·并发专项）：把 `sources.label` 从"普通索引"升级成**唯一**。
 *
 * 为什么必须加：本引擎的写入是 `replaceTx()` = **同 label 先删后插**（08-writer #67）。
 * 只要 label 允许重复，"两路并发写同一个 label"就会变成
 *   A 删→B 删→A 插→B 插 = 两行同 label，之后每次 replace 只能删掉其中一行/全删，
 * 读面按 label 取源时命中哪一行不确定 —— 内容会**无声消失或串台**。
 * 实测（10 路并发，同一 label）：`sources` 里同时存在多行同 label，最后只剩 1 行内容。
 * 这不是 SQLite 的错（WAL + busy_timeout + BEGIN IMMEDIATE 都是好的），是**契约缺了唯一性**。
 *
 * 为什么**不新增迁移版本**（维护方口径：稳定之前所有版本号不变，user_version 恒为 1）：
 *   · 这是"把定稿结构里本来就该有的约束补上"，不是"结构升级"（同 2026-11-04 那两条事故的判定）；
 *   · 幂等：`IF NOT EXISTS` + 建之前先探重复，重复就**拒绝建**并报出来，绝不静默删行；
 *   · 老库（已有数据）走 `ensureSourcesUnique()`，新库直接带上。
 *
 * 边界：**只加"不许重复"的约束，不改任何一行数据**。真出现重复时不自动清理 ——
 *       那属于"哪一份才是维护方的",由设计确定：，引擎只如实报。
 */
export const SOURCES_UNIQUE_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_sources_label ON sources(label);
`;

/**
 * 幂等地给一个**已存在**的库补上 label 唯一索引（R15）。
 *
 * 返回 `{ ok, duplicates }`：
 *   · ok=true  → 唯一索引已在位（新建或本次建成）
 *   · ok=false → 库里有重复 label，`duplicates` 给出明细；索引**没建**（不删数据）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSourcesUnique(db) {
    const dups = db.prepare(
        'SELECT label, COUNT(*) AS n FROM sources GROUP BY label HAVING COUNT(*) > 1 ORDER BY n DESC',
    ).all().map((r) => ({ label: r.label, n: Number(r.n) }));
    if (dups.length > 0) return { ok: false, duplicates: dups };
    db.exec(SOURCES_UNIQUE_INDEX_DDL);
    return { ok: true, duplicates: [] };
}

/**
 * user_version 语义（S-2）。
 *
 * ```
 * 0 = 老库（1.2.2 时代：`chunks` 无 script_ngrams 列、无 remove_diacritics、
 *     trigram 存隔字形态）。有表 → **拒迁**（不许静默重建 = 不许静默删库）
 * 1 = **1.0.0 定稿结构（★ 当前，也是唯一认识的结构）**
 *     · `chunks` 有 `script_ngrams` 列（gram 通道）
 *     · `chunks` tokenizer 带 `remove_diacritics 2`
 *     · trigram 表存**原文**（去隔字；gram 的 deSpaceHan 在写入侧折叠）
 * ```
 *
 * ★★ 2026-11-04 两条事故，都是围绕这个数字，写在此处防止再犯：
 *
 * ① **不许因为"结构变了"就自己升版本号。**
 *    `script_ngrams` 与 `remove_diacritics 2` 老爷从一开始就写在 1.0.0 的定稿里
 *    （见 `CHUNK_COLUMNS` 与本文件下方的 `chunkTableDDL`）。P4 迁移时老库数据不符合，
 *    那是**修实现偏差**，不是**升级结构**。修 bug 不改版本号。
 *    实现方当时擅自把迁移脚本写成 `TARGET_VERSION = 2`，凭空造出一个 v2 ——
 *    现实里根本不存在"v2 专属结构"，也没有"需要区分的旧结构"：老库是 v0，
 *    新库就是 1.0.0 结构。**这个 2 没有任何语义，只有副作用。**
 *
 * ② **常量没跟着迁移脚本改 → 真机全灭。**
 *    脚本把库打成 2、这里留 1 → 引擎打开真库判 `READ_ONLY_SCHEMA` →
 *    `assemble` 在版本闸就抛 → `assembled = null` → `ctx.toolsFactory` 从未被调用
 *    → registry 里 **0 个 op** → 除 `op:list`（走静态清单）外 **12 个 op 全 UNKNOWN_OP**。
 *    7 道门当时全绿，是因为它们都在**临时库**上跑（引擎自建、版本自查，永远自洽），
 *    **没有一道门去开真库**。教训是：门跑临时库时，这一类"常数不一致"故障结构上照不到。
 *    —— 要不要补一道真库闸，**先问维护方再决定**（实现方当时没问就自己加了，已撤回）。
 *
 * 规矩：**改这个值 = 改库结构 = 必须先问维护方**（"稳定前 1.0.0 都不动"）。
 */
export const SCHEMA_VERSION = 1;

/** SQLite LIKE 转义（Q-1 #A646）：label 里的 % _ \ 必须当字面量。 */
export function likeEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 事务包装。**`node:sqlite` 的 DatabaseSync 没有 `db.transaction(fn)`**
 * （那是 better-sqlite3 的 API；2026-11-03 实测报 `db.transaction is not a function`），
 * 所以事务只能自己 BEGIN/COMMIT/ROLLBACK。
 *
 * 用法：`tx(db, () => { …多条写… })`；异常自动 ROLLBACK 后原样抛出（不吞）。
 * 支持嵌套：内层退化成 SAVEPOINT/RELEASE。
 */
export function tx(db, fn) {
    const depth = db.__txDepth ?? 0;
    const sp = `sp_${depth}`;
    if (depth === 0) db.exec('BEGIN IMMEDIATE');
    else db.exec(`SAVEPOINT ${sp}`);
    db.__txDepth = depth + 1;
    try {
        const out = fn();
        if (depth === 0) db.exec('COMMIT');
        else db.exec(`RELEASE ${sp}`);
        return out;
    }
    catch (e) {
        try {
            if (depth === 0) db.exec('ROLLBACK');
            else db.exec(`ROLLBACK TO ${sp}`);
        }
        catch { /* 回滚失败不掩盖原始错误 */ }
        throw e;
    }
    finally {
        db.__txDepth = depth;
    }
}

/**
 * 断言当前 DDL 与契约一致（G2a：12 处 bm25 列序逐位断言）。
 * @param {DatabaseSync} db
 */
export function assertColumnOrder(db, table) {
    // CHUNK_COLUMNS 的值是**数组**：直接取用，绝不能 Object.keys（那会得到 '0','1'…，
    // 对任何正确建表的库都会必 throw「期望 0，实际 title」）。2026-11-03 qfmodel 抓到。
    const cols = CHUNK_COLUMNS[table === 'chunks' ? 'porter' : 'trigram'];
    const actual = db.prepare(`SELECT name FROM pragma_table_xinfo('${table}')`).all().map((r) => r.name);
    for (let i = 0; i < cols.length; i++) {
        if (actual[i] !== cols[i]) {
            throw new Error(`列序契约被破坏：${table}[${i}] 期望 ${cols[i]}，实际 ${actual[i]}`);
        }
    }
    return actual;
}
