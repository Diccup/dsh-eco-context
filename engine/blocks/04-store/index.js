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
 * 04-store — 库结构：DDL 与迁移（kind: impl，deps: ['core','project','storage']）
 *
 * 干什么：建四表（sources / chunks / chunks_trigram / vocabulary）+ 索引；
 *        `user_version` 单向迁移；表数探针。**这层不含任何写数据/查数据逻辑**，
 *        只管"库长什么样、版本怎么升"（任务书 A §二·04）。
 * 为什么这样：DDL 全部出自 libs/sql.js 的 chunkTableDDL()/SOURCES_DDL —— 列序契约
 *            只有一份事实源，两表列序逐位一致、script_ngrams 恒为第 9 列（0-based），
 *            手写一条 DDL 就破一处锁（S-1）。12 条 bm25 查询模板同样只从
 *            sql.bm25() 拼装，第三权重漏了排序会悄悄变（§五红线）。
 * 边界：打开/关闭/PRAGMA 是 03 的事；这里只接已打开的库。跨块 import 为零（D2）——
 *        迁移判据的四个分支直接用本地小函数复算，语义与 core.userVersionState
 *        一致，SCHEMA_VERSION 取自 libs/sql.js（契约冻结件），一致性由 01 的
 *        selftest 与本块 selftest 双向钉死。
 *
 * 对应需求：S-1（列序/bm25/highlight）、S-2（user_version 四态）。
 */

import { chunkTableDDL, SOURCES_DDL, bm25, highlight, assertColumnOrder, CHUNK_COLUMNS, SCHEMA_VERSION, ensureSourcesUnique } from '../../libs/sql.js';
import { err } from '../../libs/err.js';

export const NAME = 'store';

/** FTS5 建表用的两种 tokenizer（07-tokenize 的查询侧与这里必须一致）。 */
export const TOKENIZERS = Object.freeze({ porter: 'porter unicode61', trigram: 'trigram' });

/**
 * 列序逐位断言 —— **直接转调契约件 libs/sql.js 的 assertColumnOrder()**（不另写一份）。
 *
 * 2026-11-03 实现方抓到 libs 那版对数组取了 Object.keys（得到 '0','1'…），对正确的表
 * 也必 throw；已由 5903f0d2 修正并补了 libs/sql.selftest.mjs 的回归断言，队长拍板走 A。
 * 这里保留一个同名转调口（`verifyColumnOrder`）只为让本块的调用点语义清楚、
 * 返回列名的来源仍是唯一事实源 sql.js；列序契约本体绝不在块内复写。
 *
 * 注：返回的 actual 含 FTS5 影子列（chunks/rank…，排在契约 10 列之后），
 * 逐位比对的语义 = "前 10 位与 CHUNK_COLUMNS 完全一致"。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'chunks'|'chunks_trigram'} table
 * @returns {string[]} sql.js 校验通过的列名（含其后追加的 FTS5 影子列）
 */
export function verifyColumnOrder(db, table) {
    return assertColumnOrder(db, table);
}

/** 契约列名（selftest 与 08/09 都要按同一份列序说话）。 */
export { CHUNK_COLUMNS };

// ─────────────────────────────────────────────────────────
// 读库状态的三条小查询
// ─────────────────────────────────────────────────────────

/** 当前 user_version（整数）。 */
export function userVersion(db) {
    return Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);
}

/** sqlite_master 里 type='table' 的行数（FTS5 虚拟表 + 其影子/数据表都计入）。 */
export function tableCount(db) {
    return Number(
        db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c,
    );
}

/**
 * 迁移判据（= core.userVersionState 的同款四态，本地复算，见文件头"边界"）。
 * @returns {'ready'|'refuse-v0-with-tables'|'fresh'|'read-only'}
 */
export function schemaState(db) {
    const v = userVersion(db);
    if (v === SCHEMA_VERSION) return 'ready';
    if (v === 0) return tableCount(db) > 0 ? 'refuse-v0-with-tables' : 'fresh';
    return 'read-only'; // v > 认知（含异常负值）
}

// ─────────────────────────────────────────────────────────
// 建表（幂等）
// ─────────────────────────────────────────────────────────

/**
 * 幂等建四表 + 索引。DDL 一律出自 libs/sql.js，这里一行字面量都不写表结构。
 * 只在 `fresh` 态下由 migrate() 调用；直接调用也安全（IF NOT EXISTS）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{debug?:(m:string,k?:string)=>void}} [log]
 */
export function initSchema(db, log = null) {
    const emit = (m) => {
        try {
            (log?.debug ?? (() => {}))(m, 'init-schema');
        } catch { /* 日志坏不拖建表 */ }
    };
    db.exec(SOURCES_DDL); // sources(8 列，末尾 accessed_ts) + idx_sources_label + vocabulary
    db.exec(chunkTableDDL('chunks', TOKENIZERS.porter));
    db.exec(chunkTableDDL('chunks_trigram', TOKENIZERS.trigram));
    // 列序锁：建完立刻逐位断言（G2a 断言②），破约即 throw，库不带病上岗。
    verifyColumnOrder(db, 'chunks');
    verifyColumnOrder(db, 'chunks_trigram');
    // ★ R15：label 唯一（防并发"先删后插"互相吃掉）。新库必成功。
    const uq = ensureSourcesUnique(db);
    if (uq.ok) emit('sources(label) 唯一索引就位（ux_sources_label）');
    else emit(`sources(label) 有 ${uq.duplicates.length} 组重复，唯一索引未建：${uq.duplicates.map((d) => `${d.label}×${d.n}`).join(' | ')}`);
    emit('四表就绪：sources / chunks / chunks_trigram / vocabulary（列序断言通过）');
}

// ─────────────────────────────────────────────────────────
// 迁移（S-2 单向，逐条对任务书）
// ─────────────────────────────────────────────────────────

/**
 * `user_version` 迁移 —— 四条规则一个不省：
 *   ready  → 什么都不做（幂等）；
 *   fresh  → 建表 → PRAGMA user_version = 1；
 *   v0 有表 → **throw USER_VERSION_MISMATCH**（老库由维护方决定整理，引擎不猜，
 *             不许 DROP 重建=不许静默删库，红线）；
 *   v>认知 → throw READ_ONLY_SCHEMA（调用方转只读模式）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{debug?:Function,warn?:Function}} [log]
 * @returns {{state:string, version:number}} state ∈ {'ready','fresh'} 时才是走完迁移
 */
export function migrate(db, log = null) {
    const v = userVersion(db);
    const n = tableCount(db);
    const state = schemaState(db);
    switch (state) {
        case 'ready': {
            // ★ R15（2026-11-04 测试汇总）：老库也要补 label 唯一索引。
            //   这里**不升 user_version**（维护方口径：稳定前所有版本号不变），因为
            //   "唯一性"是定稿结构本来就该有的约束、不是新结构；且整个动作幂等、
            //   不改一行数据。有重复就**不建**并如实报（哪份该留是维护方的事，引擎不动）。
            let unique = { ok: true, duplicates: [] };
            try {
                unique = ensureSourcesUnique(db);
            }
            catch (e) {
                unique = { ok: false, duplicates: [], error: e?.message ?? String(e) };
            }
            if (!unique.ok) {
                try {
                    (log?.warn ?? (() => {}))(
                        unique.error
                            ? `sources(label) 唯一索引没建成：${unique.error}`
                            : `sources(label) 有 ${unique.duplicates.length} 组重复，唯一索引未建（不删数据）：${unique.duplicates.slice(0, 5).map((d) => `${d.label}×${d.n}`).join(' | ')}`,
                        'sources-unique',
                    );
                }
                catch { /* 日志坏不拖迁移 */ }
            }
            return { state, version: v, sourcesUnique: unique.ok };
        }
        case 'fresh': {
            initSchema(db, log);
            db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            const after = userVersion(db);
            if (after !== SCHEMA_VERSION) {
                throw new Error(`store.migrate(): user_version 写入失败（期望 ${SCHEMA_VERSION}，实际 ${after}）`);
            }
            return { state: 'ready', version: after, sourcesUnique: true };
        }
        case 'refuse-v0-with-tables':
            throw err('USER_VERSION_MISMATCH', { user_version: v, tables: n, why: 'v0 且库里有表：老结构，拒迁' });
        default:
            throw err('READ_ONLY_SCHEMA', { user_version: v, tables: n, known_max: SCHEMA_VERSION });
    }
}

// ─────────────────────────────────────────────────────────
// Schema 句柄
// ─────────────────────────────────────────────────────────

/**
 * 一个库的结构门面：构造即完成迁移（openDB 交给它的 db 或句柄都行）。
 * 后续块（08-writer/09-reader）通过它拿"结构已就绪"的库连接。
 */
export class Schema {
    /**
     * @param {import('node:sqlite').DatabaseSync|{db:import('node:sqlite').DatabaseSync}} dbOrHandle 03-storage 句柄或裸 DatabaseSync
     * @param {{log?:{debug?:Function,warn?:Function}}} [opts]
     */
    constructor(dbOrHandle, opts = {}) {
        this.db = dbOrHandle && dbOrHandle.db ? dbOrHandle.db : dbOrHandle;
        if (!this.db || typeof this.db.prepare !== 'function') {
            throw new TypeError('new Schema(): 需要 node:sqlite 的 DatabaseSync 或 openDB() 句柄');
        }
        const res = migrate(this.db, opts.log ?? null);
        this.state = res.state;
        this.version = res.version;
    }

    /** 列序自检（G2a 复跑用；断言失败会 throw）。 */
    checkColumnOrder() {
        return {
            chunks: verifyColumnOrder(this.db, 'chunks'),
            chunks_trigram: verifyColumnOrder(this.db, 'chunks_trigram'),
        };
    }

    /** `PRAGMA integrity_check`：返回 'ok' 或 SQLite 给的损坏报告文本。 */
    integrityCheck() {
        return String(Object.values(this.db.prepare('PRAGMA integrity_check').get())[0]);
    }
}

// ─────────────────────────────────────────────────────────
// 12 条 bm25 查询模板（G2a 断言③的拼装口）
// ─────────────────────────────────────────────────────────

/**
 * 1.2.2 的检索面是 12 条预编译 SQL（porter/trigram × 裸/label-LIKE/label-等值 ×
 * 无contentType/有contentType）。新引擎把"select 列 + FROM + JOIN + WHERE + ORDER"
 * 全部模板化，**bm25() 与 highlight() 只从 sql.js 出**，块内不许出现权重字面量。
 *
 * 注意：这里只出 SQL 文本，不 prepare —— 查询执行是 09-reader 的事（边界）。
 *
 * @returns {string[]} 恒 12 条，每条恰含 1 个 bm25(...)
 */
export function searchStatementTemplates() {
    const mk = (tbl, labelCond, ctCond) => `
SELECT
  ${tbl}.title,
  ${tbl}.content,
  ${tbl}.content_type,
  ${tbl}.timestamp,
  sources.label,
  ${bm25(tbl)} AS rank,
  ${highlight(tbl)} AS highlighted,
  ${tbl}.session_id
FROM ${tbl}
JOIN sources ON sources.id = ${tbl}.source_id
WHERE ${tbl} MATCH ?${labelCond}${ctCond}
ORDER BY rank
LIMIT ?`;
    const labelConds = [
        ['', ''], // 裸查询
        [" AND sources.label LIKE ? ESCAPE '\\'", 'Like'], // label 模糊（LIKE 转义 #646 的 ? 绑定在 09）
        [' AND sources.label = ?', 'Exact'], // label 等值
    ];
    const out = [];
    for (const tbl of ['chunks', 'chunks_trigram']) {
        for (const [lc] of labelConds) {
            out.push(mk(tbl, lc, '')); // 无 contentType 变体
            out.push(mk(tbl, lc, ` AND ${tbl}.content_type = ?`)); // 有 contentType 变体
        }
    }
    if (out.length !== 12) throw new Error(`store.searchStatementTemplates(): 期望 12 条，实际拼出 ${out.length} 条`);
    return out;
}

/** 本块不变量。 */
export const INVARIANTS = Object.freeze([
    '四表 DDL 只出自 libs/sql.js；两表列序逐位一致且 script_ngrams 为第 9 列（0-based）',
    'migrate 四态：ready 直通 / fresh 建表置 v1 / v0 有表 throw USER_VERSION_MISMATCH / v>认知 throw READ_ONLY_SCHEMA',
    '任何路径都不 DROP 既有表（静默删库红线）',
    '12 条查询模板每条恰含 1 个 bm25()，权重三元组出自 sql.js 唯一事实源',
]);

/**
 * 初始化：不主动开库（开哪库是宿主/上层的事），只提供门面挂进 ctx。
 * selftest 与后续块都从 ctx.store 取构造器。
 */
export async function init(ctx) {
    ctx.store = { NAME, Schema, initSchema, migrate, tableCount, userVersion, schemaState, searchStatementTemplates };
    return { name: NAME, schemaVersion: SCHEMA_VERSION };
}
