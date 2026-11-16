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
 * 12-lifecycle — 清理与维护（D-1/D-3/D-4/M-1…M-7）
 *
 * 干什么：14 天删线、临时库 PID 探活、僵尸库判据、完整性抽检、optimize、checkpoint、vacuum。
 * 为什么这样：14 天删线是既有事实（真库 sources 1,363 行、判据 `datetime(indexed_at)`），
 *            **但它有个危险启发式**：原版"WAL 非空且 mtime>1h → 当僵尸库删整份"，
 *            续命（accessed_ts）上线后会误杀活跃库 → 必须改成先开库读 MAX(COALESCE(...))。
 * 边界：只做清理与维护；不查询、不写入数据内容。
 *
 * 红线（04 §8.4 + 01 §十四）：
 *   ① 真删必须 dryRun:false 显式给（S7「假开关」教训）
 *   ② vacuum 不与删除绑在一起（314MB 库的 VACUUM 是重操作）
 *   ③ .persistent.db 必须被目录扫描排除（长久库永不自动删）
 *   ④ 完整性失败 → 只读报警，**永不自动重建**
 */

import fs from 'node:fs';
import { tempDir as resolveTempDir } from '../../libs/tempdir.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { err } from '../../libs/err.js';
import { tx } from '../../libs/sql.js';

const requireCjs = createRequire(import.meta.url);
/** node:sqlite 只为"只读探库"用（僵尸判据），延迟拿避免顶层副作用。 */
function DatabaseSyncClass() {
    return requireCjs('node:sqlite').DatabaseSync;
}

export const NAME = 'lifecycle';
export const INVARIANTS = [
    '真删必须 dryRun:false 显式（默认只 plan 报数）',
    '三表同判据同事务，删序 chunks → chunks_trigram → sources',
    '僵尸库判据必须先开库读 MAX(COALESCE(accessed_ts,indexed_at))，不许只看 WAL mtime',
    '.persistent.db 永不被目录扫描删',
    '完整性失败只报警不重建',
];

const RETENTION_DAYS = 14;
const ZOMBIE_WAL_IDLE_MS = 3600_000;

/**
 * 取一条 DELETE 语句的**目标表名**（第一个 `FROM` 后面紧跟的标识符）。
 *
 * 为什么需要：purge 要按删到的行数分三档报数（chunks / chunks_trigram / sources）。
 * 早期实现用 `/sources/i` 这类**正文嗅探**去分类，而
 * `DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)`
 * 的子查询里就含 `sources` —— 块的行数被记成源，回出去 `sources 2 行 / chunks 0 行`。
 * 目标表只有一个，判它本身即可，不看正文里出现了哪些词。
 *
 * @param {string} sql
 * @returns {string} 表名；认不出来返回 ''（调用方必须拒绝，不许猜）
 */
function firstTargetTable(sql) {
    const m = /\bFROM\s+["[`]?([A-Za-z_][\w$]*)["\]`]?/i.exec(String(sql ?? ''));
    return m ? m[1] : '';
}

/**
 * @param {object} deps
 * @param {object} [deps.db]         当前内容库连接（在位的库）
 * @param {string} [deps.contentDir] 库目录（做整库级清理用）
 */
export function createLifecycle(deps = {}) {
    const { db, contentDir } = deps;

    const stmt = db ? {
        chunks: db.prepare(`DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(COALESCE(accessed_ts, indexed_at)) < datetime('now', '-' || ? || ' days'))`),
        tri: db.prepare(`DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(COALESCE(accessed_ts, indexed_at)) < datetime('now', '-' || ? || ' days'))`),
        sources: db.prepare(`DELETE FROM sources WHERE datetime(COALESCE(accessed_ts, indexed_at)) < datetime('now', '-' || ? || ' days')`),
        plan: db.prepare(`SELECT label, COALESCE(accessed_ts, indexed_at) AS ts, chunk_count FROM sources WHERE datetime(COALESCE(accessed_ts, indexed_at)) < datetime('now', '-' || ? || ' days')`),
        integrity: db.prepare('PRAGMA integrity_check'),
        ftsIntegrity: db.prepare('INSERT INTO chunks(chunks) VALUES(\'integrity-check\')'),
        userVersion: db.prepare('PRAGMA user_version'),
        journalMode: db.prepare('PRAGMA journal_mode'),
        pageCount: db.prepare('PRAGMA page_count'),
        freeList: db.prepare('PRAGMA freelist_count'),
    } : null;

    /** 14 天删线 —— plan（只读）。 */
    function plan(days = RETENTION_DAYS) {
        if (!stmt) throw new Error('12-lifecycle: 需要 db');
        const rows = stmt.plan.all(days);
        return {
            days,
            wouldDeleteSources: rows.length,
            wouldDeleteChunks: rows.reduce((a, r) => a + (r.chunk_count ?? 0), 0),
            oldest: rows.length > 0 ? rows[rows.length - 1].ts : null,
            samples: rows.slice(0, 5).map((r) => ({ label: r.label, ts: r.ts, chunks: r.chunk_count })),
        };
    }

    /**
     * 14 天删线 —— 真删（三表同判据同事务）。
     * @param {{days?:number, dryRun?:boolean}} opts
     */
    function retention(opts = {}) {
        const days = opts.days ?? RETENTION_DAYS;
        if (opts.dryRun !== false) {
            // ★ 默认只 plan：真删必须显式 dryRun:false
            if (opts.dryRun === undefined) throw err('RETENTION_NEEDS_EXPLICIT', { action: 'retention', days, plan: plan(days) });
            return plan(days);
        }
        if (!stmt) throw new Error('12-lifecycle: 需要 db');
        return tx(db, () => {
            const p = stmt.chunks.run(days);
            const t = stmt.tri.run(days);
            const s = stmt.sources.run(days);
            return { days, deletedChunks: p.changes, deletedTrigram: t.changes, deletedSources: s.changes, dryRun: false };
        });
    }

    /** optimize（FTS5 段合并）。 */
    function optimize() {
        if (!db) throw new Error('12-lifecycle: 需要 db');
        db.exec('INSERT INTO chunks(chunks) VALUES(\'optimize\')');
        db.exec('INSERT INTO chunks_trigram(chunks_trigram) VALUES(\'optimize\')');
        return { optimized: true };
    }

    /** checkpoint（PASSIVE：不卡并发读者，不是 TRUNCATE）。 */
    function checkpoint(mode = 'PASSIVE') {
        if (!db) throw new Error('12-lifecycle: 需要 db');
        const out = db.prepare(`PRAGMA wal_checkpoint(${mode})`).all();
        return { mode, result: out };
    }

    /** 完整性：PRAGMA integrity_check + FTS5 'integrity-check'。失败 → 只读报警，永不重建。 */
    function integrityCheck() {
        if (!db) throw new Error('12-lifecycle: 需要 db');
        const rows = stmt.integrity.all();
        const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
        let ftsOk = true;
        let ftsError = null;
        try { stmt.ftsIntegrity.run(); }
        catch (e) { ftsOk = false; ftsError = e.message; }
        return {
            ok: ok && ftsOk,
            sqlite: ok ? 'ok' : rows.map((r) => r.integrity_check).join('; '),
            fts5: ftsOk ? 'ok' : ftsError,
            action: 'never-auto-rebuild',   // 判据写死：失败只报警
        };
    }

    /** vacuum：单独一步、单独确认。 */
    function vacuum(opts = {}) {
        if (!db) throw new Error('12-lifecycle: 需要 db');
        if (opts.dryRun !== false && opts.confirm !== true) {
            const pages = stmt.pageCount.get().page_count;
            const free = stmt.freeList.get().freelist_count;
            const pageSize = db.prepare('PRAGMA page_size').get().page_size;
            return { dryRun: true, pages, freePages: free, reclaimableBytes: free * pageSize, fileBytes: fileBytes() };
        }
        const before = fileBytes();
        db.exec('VACUUM');
        return { vacuumed: true, beforeBytes: before, afterBytes: fileBytes() };
    }

    /**
     * 库文件体积（字节）。
     *
     * ★ R13（2026-11-04 测试汇总 P1-3）：原来只 stat 主库文件，**WAL 一个字不算**。
     *   WAL 模式下未 checkpoint 的写入全在 `-wal` 里，实测这个库主文件 188.8 MB、
     *   `-wal` 189.3 MB —— 只报前者等于把体积说小一半，"库里到底占多大"这个问题
     *   永远答不对（也看不出该不该 checkpoint/vacuum）。
     *   现在回主库 + `-wal` 的合计（`-shm` 是内存映射的索引，不算数据体积）。
     *   兼容性：老调用方把返回值当数字用，这里仍是数字；明细另走 fileBytesDetail()。
     */
    function fileBytes() {
        return fileBytesDetail().totalBytes;
    }

    /** 体积明细：主库 / WAL / 合计（R13）。 */
    function fileBytesDetail() {
        const dbPath = deps.dbPath;
        if (!dbPath) return { dbBytes: 0, walBytes: 0, totalBytes: 0 };
        let dbBytes = 0; let walBytes = 0;
        try { dbBytes = fs.statSync(dbPath).size; } catch { /* 库还没落盘 */ }
        try { walBytes = fs.statSync(`${dbPath}-wal`).size; } catch { /* 没有 WAL = 0 */ }
        return { dbBytes, walBytes, totalBytes: dbBytes + walBytes };
    }

    /**
     * 僵尸库判据（D-4 修正）：**先开库读 MAX(COALESCE(accessed_ts,indexed_at))**，
     * 不许只看 WAL mtime。返回 true = 该删。
     */
    function isZombieDB(dbFile) {
        const base = path.basename(dbFile);
        if (base.endsWith('.persistent.db')) return false;                    // ★ 长久库永不被扫
        const walPath = dbFile + '-wal';
        if (!fs.existsSync(walPath)) return false;                            // 没 WAL 就不是僵尸争议对象
        const walStat = fs.statSync(walPath);
        if (walStat.size === 0) return false;
        if (Date.now() - walStat.mtimeMs <= ZOMBIE_WAL_IDLE_MS) return false; // 还在动，不是僵尸
        // ★ 真正的判据：开库读最新活动时间
        let latest = null;
        try {
            const DatabaseSync = DatabaseSyncClass();
            const probe = new DatabaseSync(dbFile, { readOnly: true });
            try {
                const row = probe.prepare('SELECT MAX(COALESCE(accessed_ts, indexed_at)) AS ts FROM sources').get();
                latest = row?.ts ?? null;
            }
            finally { probe.close(); }
        }
        catch (e) {
            // 开不开 = 真的可能坏了；坏了也不要自动删（那是数据），只报
            return false;
        }
        if (latest) {
            const ts = Date.parse(latest.includes('T') ? latest : latest.replace(' ', 'T') + 'Z');
            if (Number.isFinite(ts) && Date.now() - ts < ZOMBIE_WAL_IDLE_MS) return false;  // 刚活动过 → 活跃库
        }
        return true;
    }

    /** 整库级清理（含僵尸判据 + .persistent.db 排除）。 */
    function cleanupStaleContentDBs(dir = contentDir, maxAgeDays = RETENTION_DAYS) {
        if (!dir || !fs.existsSync(dir)) return { cleaned: 0, skippedPersistent: 0 };
        const cutoff = Date.now() - maxAgeDays * 86400_000;
        let cleaned = 0;
        let skippedPersistent = 0;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.db'))) {
            if (file.endsWith('.persistent.db')) { skippedPersistent++; continue; }   // ★
            const full = path.join(dir, file);
            try {
                const mtime = fs.statSync(full).mtimeMs;
                const shouldClean = mtime < cutoff || isZombieDB(full);
                if (!shouldClean) continue;
                for (const suffix of ['', '-wal', '-shm']) {
                    try { fs.unlinkSync(full + suffix); } catch { /* 忽略 */ }
                }
                cleaned++;
            }
            catch { /* 单文件失败不影响其他 */ }
        }
        return { cleaned, skippedPersistent };
    }

    /** 临时库 PID 探活清理（`context-mode-<pid>.db`）。 */
    function cleanupStaleDBs(tmpDir) {
        // ★ 不预设盘符：默认走操作系统临时目录（别人机器可能没有 F 盘）
        const dir = tmpDir ?? resolveTempDir();
        if (!fs.existsSync(dir)) return 0;
        let cleaned = 0;
        for (const file of fs.readdirSync(dir)) {
            const m = file.match(/^context-mode-(\d+)\.db$/);
            if (!m) continue;
            const pid = Number(m[1]);
            if (pid === process.pid) continue;
            try { process.kill(pid, 0); }
            catch {
                for (const suffix of ['', '-wal', '-shm']) {
                    try { fs.unlinkSync(path.join(dir, file + suffix)); } catch { /* 忽略 */ }
                }
                cleaned++;
            }
        }
        return cleaned;
    }

    /** ctx_doctor 的体检项（PRAGMA 基线 + user_version + 完整性 + 孤儿 WAL + persistent 误伤）。 */
    function doctor() {
        if (!db) throw new Error('12-lifecycle: 需要 db');
        const checks = [];
        const push = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

        const jm = stmt.journalMode.get().journal_mode;
        push('journal_mode=WAL', jm === 'wal', jm, 'PRAGMA journal_mode=WAL');
        const sync = db.prepare('PRAGMA synchronous').get().synchronous;
        push('synchronous=NORMAL(1)', sync === 1, String(sync), 'PRAGMA synchronous=NORMAL');
        const uv = stmt.userVersion.get().user_version;
        push('user_version=1', uv === 1, String(uv), '迁移到 v1；v0 有表是护栏，不许静默重建');

        const integ = integrityCheck();
        push('integrity_check', integ.ok, `${integ.sqlite} / fts5:${integ.fts5}`, '只读报警，永不自动重建');

        if (contentDir && fs.existsSync(contentDir)) {
            const orphanWal = fs.readdirSync(contentDir).filter((f) => f.endsWith('-wal') && !fs.existsSync(path.join(contentDir, f.slice(0, -4))));
            push('孤儿 -wal', orphanWal.length === 0, orphanWal.join(',') || 'none', '删掉孤儿 -wal/-shm');
        }

        // 长久库没被目录扫描误伤
        if (contentDir && fs.existsSync(contentDir)) {
            const persistent = fs.readdirSync(contentDir).filter((f) => f.endsWith('.persistent.db'));
            push('.persistent.db 排除', true, `发现 ${persistent.length} 个长久库，目录扫描已排除`, '—');
        }

        return { checks, failed: checks.filter((c) => !c.ok).length, total: checks.length };
    }

    /**
     * 显式清除（D-3）—— `op:purge` 的实现，2026-11-04 补。
     *
     * 为什么这条以前是死的：`14-tools` 的 purge op 写 `if (!deps.purger) throw …`，
     * 而 `16-entry` 传的是 `opts.purger ?? null`，平台层从没传过 → 每个 op:purge 调用
     * 都报「purge 实现未注入」。功能**看起来在、实际调不通**（同族第九条）。
     * 现在实现落在本块（数据在这里），装配层注入引用。
     *
     * 三个 scope（与 2.0 `core/tools/purge.ts` 同语义，一次只清一个）：
     *   · `source`  → 按 label 删该 source 的三表行（chunks → chunks_trigram → sources）
     *   · `session` → 删该 session_id 的所有块（按 chunks.session_id）
     *   · `project` → 整库蒸发（**必须 dryRun:false 显式**，且由调用方确认）
     *
     * @param {{scope:'session'|'source'|'project', session?:string, source?:string, dryRun?:boolean}} args
     */
    function purge(args = {}) {
        const { scope, session, source, dryRun } = args;
        if (!db) throw new Error('12-lifecycle: 需要 db');
        if (!scope) throw err('NO_INPUT', { reason: 'purge 需要 scope=session|source|project' });

        /** 干跑/真删的统一入口（真删必须 dryRun:false）。 */
        const exec = (planSql, planArgs, delSqls) => {
            const rows = db.prepare(planSql).all(...planArgs);
            if (dryRun !== false) {
                return { scope, dryRun: true, wouldDelete: rows.length, samples: rows.slice(0, 5) };
            }
            return tx(db, () => {
                let deletedChunks = 0; let deletedTrigram = 0; let deletedSources = 0;
                for (const sql of delSqls) {
                    const info = db.prepare(sql).run(...planArgs);
                    // ★ R-v2（2026-11-04 全功能核验②）：原来按**正则嗅探 SQL 文本**分类，
                    //   `DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)`
                    //   里带了 `sources` 字样，被 `/sources/i` 抢先命中 —— 块的行数被记成源，
                    //   于是回出去的是 `sources 2 行 / chunks 0 行`（实际 1 源 + 1 块）。
                    //   模型据此会判断「块没删掉」。分类必须依据**目标表本身**，
                    //   不能靠正文里有哪个词。改判第一个 FROM/JOIN 后紧跟的表名。
                    const target = firstTargetTable(sql);
                    if (target === 'chunks_trigram') deletedTrigram += info.changes;
                    else if (target === 'sources') deletedSources += info.changes;
                    else if (target === 'chunks') deletedChunks += info.changes;
                    else throw err('NO_INPUT', { reason: `purge 的 DELETE 目标表认不出来：${sql.slice(0, 80)}` });
                }
                return { scope, dryRun: false, deletedChunks, deletedTrigram, deletedSources };
            });
        };

        if (scope === 'source') {
            if (!source) throw err('NO_INPUT', { reason: 'purge:source 需要 source（label）' });
            // 三个 DELETE 的**删序**照 D-1：先子表（chunks/chunks_trigram）再父表（sources）
            return exec(
                'SELECT label FROM sources WHERE label = ?',
                [source],
                [
                    'DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)',
                    'DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)',
                    'DELETE FROM sources WHERE label = ?',
                ],
            );
        }
        if (scope === 'session') {
            if (!session) throw err('NO_INPUT', { reason: 'purge:session 需要 session（session id）' });
            // ★ R4（2026-11-04 测试汇总 P0-4）：原来只删 chunks/chunks_trigram，**sources 一行不动**。
            //   于是"按 session 清干净"之后，sources 里留下一批 chunk_count 还是旧值的孤儿源：
            //   · op:stats / op:list 照样把它们数进去（看着"没清掉"，其实是源没删）
            //   · 14 天删线虽然会兜底，但那要等 14 天，且期间 purge 已经回过话"已清除"= 假证据。
            //   修法：**只删这一刀打到的、且删完真的一块不剩的源**（不能无差别扫全表 ——
            //   那会顺手删掉别的会话的、以及本来就是 0 块的合法空源）。
            const hits = db.prepare('SELECT DISTINCT source_id AS id FROM chunks WHERE session_id = ?')
                .all(session).map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
            if (dryRun !== false) {
                return {
                    scope, dryRun: true,
                    wouldDelete: hits.length,
                    samples: hits.slice(0, 5).map((id) => ({ source_id: id })),
                };
            }
            return tx(db, () => {
                const deletedChunks = Number(db.prepare('DELETE FROM chunks WHERE session_id = ?').run(session).changes);
                const deletedTrigram = Number(db.prepare('DELETE FROM chunks_trigram WHERE session_id = ?').run(session).changes);
                // 扫尾：本次命中的源里，已经一块不剩的那些才算孤儿
                let deletedSources = 0;
                const leftover = db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?');
                const delSource = db.prepare('DELETE FROM sources WHERE id = ?');
                for (const id of hits) {
                    if (Number(leftover.get(id).c) === 0) deletedSources += Number(delSource.run(id).changes);
                }
                return { scope, dryRun: false, deletedChunks, deletedTrigram, deletedSources };
            });
        }
        if (scope === 'project') {
            if (dryRun !== false) throw err('RETENTION_NEEDS_EXPLICIT', { action: 'purge:project', note: '会让本库整个蒸发' });
            return tx(db, () => {
                const c = db.prepare('DELETE FROM chunks').run().changes;
                const t = db.prepare('DELETE FROM chunks_trigram').run().changes;
                const s = db.prepare('DELETE FROM sources').run().changes;
                return { scope, dryRun: false, deletedChunks: c, deletedTrigram: t, deletedSources: s, note: '整库已清空（文件仍在，只是没有内容）' };
            });
        }
        throw err('NO_INPUT', { reason: `scope 只认 session/source/project，收到 ${scope}` });
    }

    return {
        plan, retention, optimize, checkpoint, integrityCheck, vacuum, purge,
        isZombieDB, cleanupStaleContentDBs, cleanupStaleDBs, doctor,
        fileBytes, fileBytesDetail,
        _days: RETENTION_DAYS,
    };
}

export function init(ctx) { ctx.lifecycleFactory = createLifecycle; }
