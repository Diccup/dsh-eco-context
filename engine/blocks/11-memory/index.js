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
 * 11-memory — 长久记忆库（S-5 极简表）
 *
 * 干什么：第二个库文件，永不自动删。只有维护方显式 pin / remember 才进去。
 * 为什么这样：14 天删线管的是"临时缓存"；踩过的坑、定下来的结论要能活过 14 天（01 §十二）。
 *         极简单表 + 无 FTS5：长久库存的是总结不是仓库，检索走临时库的 recall 席位制。
 * 边界：不切块、不建 FTS；只做 memory 表的增删改查 + 体积闸 + category 路径校验。
 *
 * 三条硬护栏：
 *   ① category 必填 + 路径制（最多 3 段、段内不许空格）；拒收时列出既有路径让调用方照选
 *   ② 64 KB 体积闸（P-14）：超了拒收，不截断
 *   ③ 已 pin 护栏：同 label 已在长久库 → 拒收（T-12 的 hint 计数不翻倍前提）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { err } from '../../libs/err.js';
import { tx } from '../../libs/sql.js';

export const NAME = 'memory';
export const INVARIANTS = [
    'memory 单表无 FTS5（长久库存总结不存仓库）',
    'category 必填、路径制、最多 3 段、段内无空格',
    'content > 64KB 拒收不截断',
    '同 label 重复 pin = 拒收（已 pin 护栏）',
];

const MEMORY_MAX_BYTES = 65536;

export const MEMORY_DDL = `
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
`;

/**
 * 打开（或懒创建）长久库。
 * @param {string} dbPath 形如 `<contentDir>/<hash>.persistent.db`
 */
export function openMemoryDB(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(MEMORY_DDL);
    return db;
}

/** category 路径校验：`<主题>/<部分>[/<类型>]`，最多 3 段、段内不许空格。 */
export function validateCategory(category, existing = []) {
    if (typeof category !== 'string' || category.trim().length === 0) {
        throw err('MEMORY_CATEGORY_INVALID', { category: category ?? '(空)', existing });
    }
    const segs = category.split('/');
    if (segs.length > 3) throw err('MEMORY_CATEGORY_INVALID', { category, reason: `分了 ${segs.length} 段，最多 3 段`, existing });
    for (const s of segs) {
        if (s.trim().length === 0) throw err('MEMORY_CATEGORY_INVALID', { category, reason: '有空段（// 或结尾 /）', existing });
        if (/\s/.test(s)) throw err('MEMORY_CATEGORY_INVALID', { category, reason: `段「${s}」含空格`, existing });
    }
    return segs.join('/');
}

/**
 * @param {object} deps
 * @param {DatabaseSync} deps.db  长久库连接
 * @param {object} [deps.tempDb]  临时库连接（unpin 需要写回；可选）
 * @param {object} [deps.writer]  08-writer（unpin 写回临时库用）
 */
export function createMemory(deps) {
    const { db } = deps;
    if (!db) throw new Error('11-memory: 缺 db');
    const stmt = {
        list: db.prepare('SELECT id, title, category, label, created_at FROM memory ORDER BY id DESC LIMIT ?'),
        // ★★ 2026-11-09 M6（04-修复道AB故障）：**无上限**读面。
        //   道 A 的候选视野原来被 `limit: 50` 写死（plugin.js 传参 + 上面那条 LIMIT ?），
        //   于是第 51 条以后的旧经验永不可能被推 —— 而道 A 的价值恰恰在"旧"经验。
        //   修法：`limit <= 0` 表示**全量**（`LIMIT 0` 在 SQLite 里是"取 0 行"，正好反过来，
        //   所以必须走另一条不带 LIMIT 的语句，不能在原语句上传 0）。
        listAll: db.prepare('SELECT id, title, category, label, created_at FROM memory ORDER BY id DESC'),
        get: db.prepare('SELECT id, title, content, category, label, created_at FROM memory WHERE id = ?'),
        byLabel: db.prepare('SELECT id, title, content, category, label, created_at FROM memory WHERE label = ?'),
        insert: db.prepare('INSERT INTO memory (title, content, category, label) VALUES (?, ?, ?, ?)'),
        update: db.prepare('UPDATE memory SET title = ?, content = ?, category = ? WHERE id = ?'),
        setCat: db.prepare('UPDATE memory SET category = ? WHERE id = ?'),
        del: db.prepare('DELETE FROM memory WHERE id = ?'),
        delByLabel: db.prepare('DELETE FROM memory WHERE label = ?'),
        cats: db.prepare('SELECT DISTINCT category FROM memory ORDER BY category'),
        size: db.prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) AS bytes, COUNT(*) AS rows FROM memory'),
    };

    const existingCats = () => stmt.cats.all().map((r) => r.category);

    /** 字节闸（P-14）：按 UTF-8 字节算，不按字符。 */
    function assertSize(content, title) {
        const bytes = Buffer.byteLength(content ?? '', 'utf8');
        if (bytes > MEMORY_MAX_BYTES) {
            throw err('MEMORY_TOO_BIG', {
                bytes,
                limit: MEMORY_MAX_BYTES,
                hint: '整份原文放临时库（ctx op=index），长久库只存这条的结论',
            });
        }
        if (typeof title !== 'string' || title.trim().length === 0) {
            throw err('MEMORY_CATEGORY_INVALID', { reason: 'title 必填' });
        }
    }

    /** 记住一条（ctx_remember）。 */
    function remember({ title, content, category, label }) {
        assertSize(content, title);
        const cat = validateCategory(category, existingCats());
        const finalLabel = label ?? `remember:${title}`;
        const existed = stmt.byLabel.get(finalLabel);
        if (existed) {
            // 同 label 重复 remember = 覆盖（与 pin 不同：remember 是手录，天然可改）
            return tx(db, () => {
                stmt.update.run(title, content, cat, existed.id);
                return { id: existed.id, label: finalLabel, category: cat, updated: true };
            });
        }
        return tx(db, () => {
            const info = stmt.insert.run(title, content, cat, finalLabel);
            return { id: Number(info.lastInsertRowid), label: finalLabel, category: cat, created_at: undefined };
        });
    }

    /**
     * 把临时库的一个 source 钉进来（pin）：多块合并成一行。
     * @param {{label:string, category:string, title?:string, chunks:Array<{title:string,content:string}>}} args
     */
    function pin({ label, category, chunks, title }) {
        if (!label || !category) throw err('NO_SCHEMA_PIN');
        const cat = validateCategory(category, existingCats());
        const existed = stmt.byLabel.get(label);
        if (existed) throw err('MEMORY_LABEL_PINNED', { label, existingCategory: existed.category });   // 已 pin 护栏
        if (!Array.isArray(chunks) || chunks.length === 0) throw err('NO_INPUT', { reason: `label=${label} 在临时库没有块` });

        // 合并成一行：ORDER BY rowid 的顺序由调用方保证
        const merged = chunks.map((c) => c.content).join('\n\n');
        const finalTitle = title ?? chunks[0].title;
        assertSize(merged, finalTitle);

        return tx(db, () => {
            const info = stmt.insert.run(finalTitle, merged, cat, label);
            return { id: Number(info.lastInsertRowid), label, category: cat, mergedBytes: Buffer.byteLength(merged, 'utf8'), fromChunks: chunks.length };
        });
    }

    /** 反钉（unpin）：把 content 交回调用方写回临时库，然后删这行。 */
    function unpin({ label }) {
        const row = stmt.byLabel.get(label);
        if (!row) throw err('NO_INPUT', { reason: `长久库没有 label=${label}` });
        return tx(db, () => {
            stmt.delByLabel.run(label);
            return { label, title: row.title, content: row.content, category: row.category, released: true };
        });
    }

    /**
     * 读面：list 永不自动带正文（正文走 get）。
     *
     * ★★ 2026-11-09 M6：新增 `limit <= 0` = **全量**（道 A 取数口用）。
     *   注意默认值仍是 50 —— 那是**模型面** `op:"memory" action:"list"` 的渲染默认，
     *   动它会改用户可见输出，所以只加"显式全量"这条路，不碰默认值。
     * @param {{limit?:number}} [args]
     */
    function list({ limit = 50 } = {}) {
        const rows = Number(limit) <= 0 ? stmt.listAll.all() : stmt.list.all(Number(limit));
        return rows.map((r) => ({
            id: r.id, title: r.title, category: r.category, label: r.label, createdAt: r.created_at,
        }));
    }

    /**
     * 按 id **或 label** 读一行（R12）。
     *
     * 原来只认数字 id：调用方给 `label` 时，这个字符串被直接绑进 `WHERE id = ?`，
     * node:sqlite 绑不上会抛 `ERR_INVALID_ARG_TYPE: Provided value cannot be bound to
     * SQLite parameter 1` —— 一句面向实现者的栈内错误，模型读不懂也不知道该改成什么。
     * `byLabel` 语句本来就备着（L82，pin/unpin 在用），这里接上就行：
     * 数字 = id，字符串 = label（label 唯一，见 MEMORY_DDL 的 UNIQUE）。
     * @param {number|string} idOrLabel
     */
    function get(idOrLabel) {
        const r = (typeof idOrLabel === 'string' && !/^\d+$/.test(idOrLabel.trim()))
            ? stmt.byLabel.get(idOrLabel)
            : stmt.get.get(Number(idOrLabel));
        if (!r) return null;
        return { id: r.id, title: r.title, content: r.content, category: r.category, label: r.label, createdAt: r.created_at };
    }

    function setCategory({ id, category }) {
        const cat = validateCategory(category, existingCats());
        const r = stmt.get.get(id);
        if (!r) throw err('NO_INPUT', { reason: `没有 id=${id}` });
        return tx(db, () => { stmt.setCat.run(cat, id); return { id, category: cat, updated: true }; });
    }

    /** delete 是唯一允许删长久记忆的入口（机器不自动删）。 */
    function remove({ id }) {
        const r = stmt.get.get(id);
        if (!r) throw err('NO_INPUT', { reason: `没有 id=${id}` });
        return tx(db, () => { stmt.del.run(id); return { id, deleted: true, label: r.label }; });
    }

    function stats() {
        const s = stmt.size.get();
        return { rows: s.rows, bytes: s.bytes, limit: MEMORY_MAX_BYTES, categories: existingCats() };
    }

    return { remember, pin, unpin, list, get, setCategory, remove, stats, existingCats, close: () => { try { db.close(); } catch { /* 忽略 */ } } };
}

export function init(ctx) { ctx.memoryFactory = createMemory; }
