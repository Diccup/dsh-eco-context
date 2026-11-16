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
 * 08-writer — 写入（事务内 by-label 先删后插、双表写、vocabulary、续命置 NULL）
 *
 * 干什么：把 chunk[] 写进 chunks / chunks_trigram 两表 + vocabulary 真表，且同 label 重写=整体替换。
 * 为什么这样：① 同 label 先删后插是 #67 的护栏（迭代工作流 build-fix-build 不积脏块）；
 *            ② FTS5 没有列级 UPDATE，替换只能整源删插，content_hash 是唯一变更判据；
 *            ③ 写放大实测 2.72→2.82×（库定稿 §2.2），所以双表必须写同样内容，不许"只写一边"。
 * 边界：不切块（调 05-analyze）、不构 gram（调 06-gram）、不拼 SQL 字面量（调 libs/sql.js）。
 *
 * 三个继承来的回归护栏（一个都不许丢）：
 *   #350  content="" + path → 回退读文件（空串不是"有内容"）
 *   #442  openSync+fstat+readFileSync(fd) 绑定 inode，堵 TOCTOU 换符号链接
 *   #67   by-label 先删后插，事务内
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { relative as pathRelative, sep } from 'node:path';
import { err } from '../../libs/err.js';
import { tx } from '../../libs/sql.js';

export const NAME = 'writer';
export const INVARIANTS = [
    '同 label 整体替换，事务内先删后插，不留脏块',
    '替换后 sources.accessed_ts 置 NULL（新内容未命中过）',
    'content 为空串时必须回退读 path（#350）',
    '文件读取必须 openSync+fstat+readFileSync(fd)（#442）',
    // ★ 2026-11-14（项目 07）新增两条：
    '文件按严格 UTF-8 解码（TextDecoder fatal）；解码失败 = 二进制 → 不写库（NOT_TEXT）',
    'content 形态只含空白 → 拒收 NO_INPUT（不许建 0 块垃圾源行）',
];

const OPTIMIZE_EVERY = 50;
/**
 * M-3 完整性抽检间隔（每 N 次插入跑一次）。
 * 出处：`引擎库侧需求.md` M-3「每 500 次插入跑一次 `PRAGMA integrity_check`（1ms 级）
 *       + `INSERT INTO chunks(chunks) VALUES('integrity-check')`（FTS5 一致性，
 *       比 integrity_check 严格、专查 shadow 表漂移）。失败 → 该库进"只读+报警"，不自动重建」。
 */
const INTEGRITY_EVERY = 500;

/**
 * 无 source 时起的唯一 label（R3）。前缀 `untitled:` 让族筛/清理照旧认得出，
 * 后面跟时间戳 + 随机后缀保证**每次写入都不撞**（撞 = 先删后插会吃掉上一条）。
 */
function uniqueLabel() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `untitled:${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * 建一个写入器。deps 由 registry 注入（保持块内不写死别的块）：
 * @param {object} deps
 * @param {object} deps.db          已打开的 DatabaseSync
 * @param {object} deps.analyze     05-analyze（chunk/normalize/assertChunks）
 * @param {object} deps.gram        06-gram（buildScriptNgrams）
 * @param {object} [deps.denyChecker] (filePath)=>boolean，刷新前再查一次策略
 */
export function createWriter(deps) {
    const { db, analyze, gram } = deps;
    if (!db) throw new Error('08-writer: 缺 db');
    if (!analyze || !gram) throw new Error('08-writer: 缺 analyze/gram');

    // ── 预编译语句（写入热路径） ──
    const stmt = {
        insSourceEmpty: db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)'),
        insSource: db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)'),
        delChunksByLabel: db.prepare('DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)'),
        delTriByLabel: db.prepare('DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)'),
        delSourceByLabel: db.prepare('DELETE FROM sources WHERE label = ?'),
        insChunk: db.prepare('INSERT INTO chunks (title, content, script_ngrams, source_id, content_type, source_category, session_id, event_id, timestamp, accessed_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)'),
        // ★ chunks_trigram **不带 script_ngrams**（库定稿 §1.2「不加列」）：
        //   同一份 gram 文本存两遍 = 写放大从 3.19× 涨到 3.63×（P-02 口径实测，T-7 抓到的）。
        insTri: db.prepare('INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp, accessed_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)'),
        insVocab: db.prepare('INSERT OR IGNORE INTO vocabulary (word) VALUES (?)'),
        getMeta: db.prepare('SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash, accessed_ts FROM sources WHERE label = ?'),
    };
    let insertCount = 0;

    /**
     * fd 绑定读取（#442）：打开 → fstat 验普通文件 → 从 fd 读 → 关。
     *
     * ★★ 2026-11-14（项目 07）：**严格 UTF-8 解码**（对齐第三方 /`src/core/tools/index.ts` 的 `readUtf8`）。
     *
     * 修前的病根：`readFileSync(fd, 'utf-8')` 对二进制文件**不报错**，而是把每个非法字节
     * 换成 U+FFFD（`\uFFFD`）。后果有两个，都是真的：
     *   ① 一屏乱码写进库 —— 体积白白涨、检索池被污染（乱码块永远不可能被正确召回）；
     *   ② 更坏的是**它看起来成功了**：`indexed 1 source / N chunks`，模型以为文件读进来了。
     * 做法是 `new TextDecoder('utf-8', { fatal: true })`：解码失败 → 返回 undefined →
     * 该文件**跳过、不报错**（"文件夹里混进二进制文件"是常态，不该让整次 index 失败）。
     *
     * 这里保留"跳过"语义，但**必须让调用方知道跳过了什么**：返回 `{ text }` 或
     * `{ binary: true }`，由 `write()` 决定抛错还是跳过（见下面的 `NOT_TEXT` 处理）。
     *
     * @param {string} filePath
     * @returns {{ text: string } | { binary: true }}
     */
    const utf8Strict = new TextDecoder('utf-8', { fatal: true });
    function readFileBound(filePath) {
        let fd;
        try {
            fd = fs.openSync(filePath, 'r');
        }
        catch (e) {
            throw err('NOT_REGULAR_FILE', { path: filePath, reason: e.code ?? e.message });
        }
        try {
            const st = fs.fstatSync(fd);
            if (!st.isFile()) throw err('NOT_REGULAR_FILE', { path: filePath, reason: '不是普通文件' });
            const buf = fs.readFileSync(fd);
            try {
                // ★ 先剥 UTF-8 BOM：某些编辑器会写 BOM，剥掉它才与 `normalize()` 的
                //   "只去 BOM + NUL"口径一致（两边都不许把 BOM 当正文）。
                return { text: utf8Strict.decode(buf).replace(/^\uFEFF/, '') };
            }
            catch {
                // 不是合法 UTF-8 = 二进制。不许写进库（跳过，不报错）。
                return { binary: true };
            }
        }
        finally {
            try { fs.closeSync(fd); } catch { /* 忽略 */ }
        }
    }

    /** 事务内 by-label 先删后插（#67）。 */
    function replaceTx(label, chunks, text, filePath, contentHash, attribution) {
        return tx(db, () => {
            stmt.delChunksByLabel.run(label);
            stmt.delTriByLabel.run(label);
            stmt.delSourceByLabel.run(label);

            const codeChunks = chunks.filter((c) => c.hasCode).length;
            if (chunks.length === 0) {
                const info = stmt.insSourceEmpty.run(label, filePath ?? null, contentHash ?? null);
                return { sourceId: Number(info.lastInsertRowid), chunkCount: 0, codeChunks: 0 };
            }
            const info = stmt.insSource.run(label, chunks.length, codeChunks, filePath ?? null, contentHash ?? null);
            const sourceId = Number(info.lastInsertRowid);
            const now = new Date().toISOString();
            const sessionId = attribution?.sessionId ?? '';
            const eventId = attribution?.eventId ?? '';
            // ★ source_category：原来硬编码 null（S-6 共同义务① 要求同语法落值）
            const category = attribution?.category ?? null;
            for (const c of chunks) {
                const contentType = c.hasCode ? 'code' : 'prose';
                // gram 列**只写 chunks 表**（库定稿 §1.2：trigram 表不加列）
                const ngrams = gram.buildScriptNgrams(c.title, c.content);
                stmt.insChunk.run(c.title, c.content, ngrams, sourceId, contentType, category, sessionId, eventId, now);
                stmt.insTri.run(c.title, c.content, sourceId, contentType, category, sessionId, eventId, now);
            }
            return { sourceId, chunkCount: chunks.length, codeChunks };
        });
    }

    /** 抽词进 vocabulary 真表（P-05：不换虚表，getDistinctiveTerms 需要跨块词频）。 */
    function vocabTx(text) {
        return tx(db, () => {
            // ★ foldForSearch：vocabulary 是**检索词表**，必须走归一（全角→半角）。
            //   不能用 normalize()（它现在只清 BOM、保原文），否则 ＡＢＣ 与 ABC 拆成两个词条。
            const words = analyze.foldForSearch(text).toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
                .filter((w) => w.length >= 3);
            let inserted = 0;
            for (const w of new Set(words)) inserted += stmt.insVocab.run(w).changes;
            return inserted;
        });
    }

    function optimizeFTS() {
        try {
            db.exec('INSERT INTO chunks(chunks) VALUES(\'optimize\')');
            db.exec('INSERT INTO chunks_trigram(chunks_trigram) VALUES(\'optimize\')');
        }
        catch { /* 尽力而为：优化失败不阻塞写入 */ }
    }

    /**
     * M-3 完整性抽检（每 500 次插入一次）。
     *
     * 两条判据（M-3 原文）：
     *   ① `PRAGMA integrity_check` —— 整库结构（1ms 级）
     *   ② `INSERT INTO chunks(chunks) VALUES('integrity-check')` —— FTS5 一致性，
     *      **比 integrity_check 严格**，专查 shadow 表漂移（这是 FTS5 自己的校验命令）
     *
     * 失败处理（**关键**）：只报警 + 置只读标志，**永不自动重建**（红线：失败只读报警，
     * 不许自动删数据）。报警通过返回值上报，由装配层 / op:doctor 读。
     */
    let integrityFailing = false;
    let lastIntegrity = null;
    function integrityProbe() {
        const out = { ok: true, sqlite: 'ok', fts5: 'ok', at: new Date().toISOString() };
        try {
            const rows = db.prepare('PRAGMA integrity_check').all();
            const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
            out.ok = ok;
            out.sqlite = ok ? 'ok' : rows.map((r) => r.integrity_check).join('; ');
        }
        catch (e) {
            out.ok = false;
            out.sqlite = `报错：${e.message}`;
        }
        try {
            db.exec('INSERT INTO chunks(chunks) VALUES(\'integrity-check\')');
        }
        catch (e) {
            out.ok = false;
            out.fts5 = e.message;
        }
        integrityFailing = !out.ok;
        lastIntegrity = out;
        return out;
    }

    /**
     * 写入主入口（对应 1.2.2 的 index）。
     * @param {{content?:string, path?:string, source?:string, kind?:'markdown'|'plain'|'json',
     *          attribution?:object, sessionId?:string, category?:string, maxChunkBytes?:number}} opts
     *   `sessionId` —— 写进 chunks.session_id（tier boost 的判据列，Q-3）；
     *   `category`  —— 写进 chunks.source_category（S-6 共同义务①）。
     */
    function write(opts) {
        const { content, path: filePath, source, kind = 'markdown', attribution, sessionId, category, maxChunkBytes } = opts ?? {};
        const hasContent = typeof content === 'string' && content.length > 0;   // #350
        if (!hasContent && !filePath) throw err('NO_INPUT');

        // ★★ 2026-11-14：空内容闸（空/无词内容不入默认检索）。
        //   修前 `index{content:"   "}` 会建一个 **0 块** 的源行：它占 sources 表一行、
        //   占一个 label、在 stats 里算一个源，但什么也搜不到 —— 纯垃圾。
        //   现在：给了 content 但去掉空白后为空 → 明确拒收，**第一行给能抄的正确写法**（err 契约）。
        //   ★ 只挡 content 形态；path 形态的空文件由 `readFileBound` 读到空串，
        //     那是文件真的空，属于事实，按 0 块源写入（有 label、可被 recall 到"它存在但为空"）。
        if (hasContent && content.trim().length === 0) {
            throw err('NO_INPUT', {
                reason: 'content 只有空白（含空串/纯空格/纯换行）；要入库就给真内容，'
                    + '或改用 path 指向文件：{op:"index", path:"<绝对路径>"}',
            });
        }

        let text;
        if (hasContent) { text = content; }
        else {
            const got = readFileBound(filePath);
            if (got.binary === true) {
                // ★ 语义：二进制**跳过、不报错**。但这里是**单文件**入口（不是目录遍历），
                //   调用方点名要的就是这个文件 —— 静默跳过等于骗它"入库成功"。
                //   所以给一个可读的 `NOT_TEXT`（文案在 libs/err.js，第一行就是怎么改）：
                //   模型看到就知道"这个文件本来就该跳过"，不会反复重试同一个调用。
                const e = err('NOT_TEXT', { path: filePath });
                e.binary = true;
                throw e;
            }
            text = got.text;
        }

        // ★ R3（2026-11-04 测试汇总 P0-1，**真丢数据**）：
        //   原来是 `source ?? filePath ?? 'untitled'` —— 固定字面量。
        //   而本块的写入是 `replaceTx()`（同 label **先删后插**，见 INVARIANTS 第 1 条），
        //   于是"两次不给 source 的 index"= 第二次把第一次的内容**整源删掉再写**，
        //   模型看到的却是两条都成功。这就是报告里"写了两次只剩最后一次"的根因。
        //
        //   对照 2.0（b07-tools-index/core/tools/index.ts）：它缺省 label 也是固定值 "content"，
        //   但 2.0 的写入是**追加新源**、不做 by-label 替换 —— 固定 label 在那边不丢数据。
        //   所以**不是"默认值"错了，是"固定默认值 + 先删后插"的组合错了**。两个解法：
        //     ① 每个无 source 的写入都起唯一 label（保留可用性，不丢数据）；← 采这个
        //     ② 无 source 就拒（更严，但会把现有调用方全打断）
        //   唯一 label 仍带 `untitled:` 前缀，族筛/清理照旧认得出。
        const label = source ?? filePath ?? uniqueLabel();
        if (source != null && String(source).trim().length === 0) throw err('NO_INPUT', { reason: 'source 给了空串；要么给一个有意义的 label，要么不给（不给时引擎自动起唯一 label）' });
        const chunks = analyze.chunk(text, kind, { maxChunkBytes });
        analyze.assertChunks(chunks, maxChunkBytes);

        const fp = filePath ?? undefined;
        const hash = fp ? createHash('sha256').update(text).digest('hex') : undefined;

        // ★ attribution 三件套：sessionId / eventId / category
        //   sessionId 来自参数或 attribution（调用方两处都传得进来）；
        //   category 写 source_category（S-6：临时库 chunks.source_category 同语法落值）。
        const attr = {
            sessionId: sessionId ?? attribution?.sessionId ?? '',
            eventId: attribution?.eventId ?? '',
            category: category ?? attribution?.category ?? null,
        };

        const r = replaceTx(label, chunks, text, fp, hash, attr);
        if (text) vocabTx(text);
        insertCount++;
        if (insertCount % OPTIMIZE_EVERY === 0) optimizeFTS();
        // ★ M-3：每 500 次插入抽检一次（失败只报警置标志，永不重建）
        if (insertCount % INTEGRITY_EVERY === 0) integrityProbe();
        return { sourceId: r.sourceId, label, totalChunks: r.chunkCount, codeChunks: r.codeChunks };
    }

    /** 纯文本写入（日志/构建输出）。 */
    function writePlainText(content, source, linesPerChunk = 20, attribution) {
        if (!content || content.trim().length === 0) {
            const r = replaceTx(source, [], '', undefined, undefined, attribution);
            return { sourceId: r.sourceId, label: source, totalChunks: 0, codeChunks: 0 };
        }
        const chunks = analyze.chunkPlainText(content, linesPerChunk);
        analyze.assertChunks(chunks);
        const r = replaceTx(source, chunks.map((c) => ({ ...c, hasCode: false })), content, undefined, undefined, attribution);
        vocabTx(content);
        return { sourceId: r.sourceId, label: source, totalChunks: r.chunkCount, codeChunks: 0 };
    }

    /** JSON 写入（key path 当标题）。 */
    function writeJSON(content, source, attribution) {
        if (!content || content.trim().length === 0) return writePlainText('', source, undefined, attribution);
        try { JSON.parse(content); }
        catch { return writePlainText(content, source, undefined, attribution); }
        const chunks = analyze.chunkJSON(content);
        analyze.assertChunks(chunks);
        const r = replaceTx(source, chunks, undefined, undefined, undefined, attribution);
        vocabTx(content);
        return { sourceId: r.sourceId, label: source, totalChunks: r.chunkCount, codeChunks: chunks.filter((c) => c.hasCode).length };
    }

    /**
     * 目录写入（逐文件 write；per-file label = `<source>:<relPath>`）。
     *
     * ★ 2026-11-04 P3 #13 两条修正（否则这条路径一直静默失败）：
     *   ① 原来这里引用了**未定义**的 `attribution` → ReferenceError 被 `catch { failed++ }` 吞掉
     *      → 每个文件都"失败"，返回 `filesIndexed=0, failed=N`（实测就是 0 个文件）。
     *      现在把 writeOpts（sessionId/category/attribution）从入参显式接进来。
     *   ② per-file label 原来直接拼**绝对路径**（`<source>:<F:\...绝对路径>`），
     *      与 2.0 的 `pathLabel(relative)` 口径不一致（2.0 存相对路径，跨盘可迁移）。
     *      现在 label 用「相对根目录的 posix 路径」，`source` 仍是调用方给的前缀。
     */
    function writeDirectory(opts) {
        const { path: root, source, perFileDeny, sessionId, category, attribution, ...walkOpts } = opts ?? {};
        const project = deps.project;
        if (!project) throw new Error('08-writer: 目录写入需要 project 块（walkDirectoryDetailed）');
        const walked = project.walkDirectoryDetailed(root, walkOpts);
        let filesIndexed = 0; let totalChunks = 0; let denied = 0; let failed = 0; let skippedBinary = 0;
        const failures = [];
        for (const file of walked.files) {
            if (perFileDeny && perFileDeny(file)) { denied++; continue; }
            try {
                // 相对路径（posix）当 label 后缀；拿不到相对路径就退回文件名
                let rel = file;
                try {
                    const r = projectRelative(root, file);
                    if (r) rel = r;
                }
                catch { /* 拿不到相对路径：退回原样 */ }
                const fileSource = source ? `${source}:${rel}` : rel;
                const baseName = String(rel).split(/[/\\]/).pop() ?? rel;
                const r = write({ path: file, source: fileSource, sessionId, category, attribution,
                    kind: /\.json$/i.test(baseName) ? 'json' : 'markdown' });
                filesIndexed++; totalChunks += r.totalChunks;
            }
            catch (e) {
                // ★ 2026-11-14（项目 07）：二进制文件**不计失败**，单独计 `skippedBinary`。
                //   理由：目录里混进 PNG/EXE 是常态（跳过不报错）。
                //   把它算进 `failed` 会让"20 个文件里 3 个失败"看起来像出了事故，
                //   而实际是"3 个本来就不是文本"。但**也不许静默**：数字照报。
                if (e && e.binary === true) { skippedBinary++; continue; }
                failed++;
                if (failures.length < 3) failures.push(`${file}: ${e.message.split('\n')[0]}`);
            }
        }
        return {
            filesIndexed, totalChunks, capped: walked.capped, totalSeen: walked.totalSeen,
            denied, failed, skippedBinary, failures, label: source ?? root,
        };
    }

    /** 相对根目录的 posix 路径（跨盘/不同分隔符都退回 null，由调用方处理）。 */
    function projectRelative(root, file) {
        try {
            const rel = pathRelative(root, file);
            if (!rel || rel.startsWith('..')) return null;
            return rel.split(sep).join('/');
        }
        catch { return null; }
    }

    /** 文件源过期刷新（M-5）：mtime 快筛 → 变了才算 hash → 真变了才重写。 */
    function refreshStaleSources() {
        const rows = db.prepare('SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL').all();
        let refreshed = 0;
        for (const src of rows) {
            try {
                if (!fs.existsSync(src.file_path)) continue;
                if (deps.denyChecker && deps.denyChecker(src.file_path)) continue;   // #442 r3
                const mtime = fs.statSync(src.file_path).mtime;
                if (mtime <= new Date(src.indexed_at + 'Z')) continue;              // 快筛
                // ★ 2026-11-14（项目 07）：`readFileBound` 现在回 `{text}` 或 `{binary}`。
                //   变成二进制（文件被换成了图片/压缩包）→ **跳过**，不重写、不报错：
                //   它原来入库时是文本，现在不是了，属于"该源已不可刷新"，不是错误。
                const got = readFileBound(src.file_path);
                if (got.binary === true) continue;
                const newContent = got.text;
                const newHash = createHash('sha256').update(newContent).digest('hex');
                if (newHash === src.content_hash) continue;                         // 内容没变
                write({ content: newContent, path: src.file_path, source: src.label });
                refreshed++;
            }
            catch { /* 刷新失败不阻断查询 */ }
        }
        return refreshed;
    }

    return {
        write, writePlainText, writeJSON, writeDirectory, refreshStaleSources,
        optimizeFTS,
        // ★ M-3：抽检可见性（装配层 / op:doctor / stats 读它）
        integrityProbe,
        integrityState: () => ({ failing: integrityFailing, last: lastIntegrity, every: INTEGRITY_EVERY, inserted: insertCount }),
        getMeta: (label) => {
            const r = stmt.getMeta.get(label);
            if (!r) return null;
            return {
                label: r.label, chunkCount: r.chunk_count, codeChunkCount: r.code_chunk_count,
                indexedAt: r.indexed_at, filePath: r.file_path ?? null, contentHash: r.content_hash ?? null,
                accessedTs: r.accessed_ts ?? null,
            };
        },
        _optimizeEvery: OPTIMIZE_EVERY,
        _bm25: () => bm25('chunks'),
    };
}

export function init(ctx) {
    // 由 14-tools / 16-entry 在拿到 db 与依赖后调用 createWriter；这里不自动连库。
    ctx.writerFactory = createWriter;
}
