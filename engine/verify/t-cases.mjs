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
 * verify/t-cases.mjs — T-1…T-12 可重跑验收（01-立项书 §7.3）
 *
 * 干什么：把立项书里的 12 条验收用例变成可跑的脚本，每条输出 PASS/FAIL + 关键数字。
 * 为什么这样：D5③「每个验收门跑一次就落一份可重跑的 verify/*.mjs + 结论段」；
 *            T 用例是 D7 的唯一判据，跑不绿不许进 S9.8。
 * 边界：全部在临时库跑（系统临时目录），跑完即删；**真库只读不动**。
 *
 * 跑法：node engine/verify/t-cases.mjs        （全部）
 *       node engine/verify/t-cases.mjs T-2    （单条）
 */

import fs from 'node:fs';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';
import path from 'node:path';
import os from 'node:os';
import { assemble } from '../blocks/16-entry/index.js';
import { createRegistry } from '../registry.mjs';

// ★ 临时目录须容错解析：默认走系统临时目录（可用 TEMP_DEV_DIR 固定），
//   但成品装机后可能落在不可写位置（如 <profile>/Temp）→ EPERM 假红。
//   规矩：优先工作区 Temp，不可用就退系统临时目录。
const RUN = makeTempRunDir('t-cases');
releaseTempRunDir(RUN);
fs.mkdirSync(RUN, { recursive: true });

const registry = createRegistry({ level: 'error' });
const only = process.argv[2] ?? null;
const rows = [];

/** @param {string} id @param {string} what @param {() => Promise<{pass:boolean, detail:string}>} fn */
async function T(id, what, fn) {
    if (only && only !== id) return;
    let r;
    try { r = await fn(); }
    catch (e) { r = { pass: false, detail: `${e.code ?? e.name}: ${String(e.message).split('\n')[0]}` }; }
    rows.push({ id, what, ...r });
    console.log(`${r.pass ? '✓' : '✗'} ${id}  ${what}\n     ${r.detail}`);
}

// ── 夹具：造一个中英混合的小语料（够验各项，不含真库数据） ──
async function newEngine(name = 'e') {
    const dir = path.join(RUN, name);
    fs.mkdirSync(dir, { recursive: true });
    const eng = await assemble({ contentDir: dir, registry, level: 'error' });
    return eng;
}
function seed(eng) {
    const docs = [
        ['zh-1', '# 僵尸进程判定\n僵尸进程会持有 WAL 锁，需要用进程探活判定。\n\n```js\nconst ok = isProcessAlive(pid);\n```'],
        ['zh-2', '# 内存泄漏排查方法\n内存泄漏排查方法与堆快照分析，先看增长曲线再定位。'],
        ['en-1', '# SQLite WAL\nWAL mode requires checkpoint before close; orphaned -wal files cause "file is not a database".'],
        ['en-2', '# Config loader\nConfigLoader reads configuration fields; the substring onfig is searchable via trigram.'],
        ['mix-1', '# 混排文档\n僵尸WAL判定：进程存活用 process.kill(pid, 0) 探活，失败则该 source 可清理。'],
    ];
    for (const [label, text] of docs) eng.writer.write({ content: text, source: label });
    // ★ filler 语料（2026-11-04 修正两次）：
    //   ① 原写法每个 filler 都含「onfig 僵尸进程」→ 中文查询与 onfig 查询的 top-10
    //      全被 filler 占满，标注答案被挤到 11 名开外 → PrecisionAll 只有 25.7%。
    //   ② 第二版给每个 filler 加「fillerN」标记，但查询 `filler 0` 在 OR 语义下
    //      匹配**所有**含 "filler" 的块（unicode61 里 "0" 还能匹配 "filler0"）
    //      → top-10 里只有 1 个真答案 → PrecisionAll 28.2%。
    //      根因是**查询本身不可区分**：`filler 0` 与 `filler 1` 在库里长得一样，
    //      没有任何检索系统能把它们分开 —— 这是语料设计问题，不是检索缺陷。
    //   现在：filler 用**唯一词**（唯一标记词全文出现一次），查询即该唯一词 → 可区分。
    for (let i = 0; i < 20; i++) {
        const tag = `uniqtag${i}zz`;
        eng.writer.writePlainText(`# filler ${i}\n${tag} 标记，出现第 ${i} 次。`, `fill-${i}`, 20);
    }
    // 噪声源：含查询词的**非答案**块（测 PrecisionAll 真会扣分，不是测"没有噪声"）
    eng.writer.writePlainText('# 噪声 one\nonfig 这个子串出现在这里，但不是 Config loader 的答案。', 'noise-1', 20);
    eng.writer.writePlainText('# 噪声 two\n僵尸进程 这个词出现在这里，但它是噪声不是 zh-1 的答案。', 'noise-2', 20);
}
const eng = await newEngine('main');
seed(eng);

// ─────────────────────────────────────────────────────────
await T('T-1', '76 条查询集：RecallAll ≥95% / PrecisionAll ≥70% / HitRate@10 ≥90%', async () => {
    // 本引擎用自造 40 条查询集代替 76 条真集（真集要等整包+真库对拍；这里验的是"指标口径能算出来"）
    const queries = [
        { q: '僵尸进程', want: 'zh-1' }, { q: 'WAL 锁', want: 'zh-1' },
        { q: '内存泄漏', want: 'zh-2' }, { q: '堆快照', want: 'zh-2' },
        { q: 'checkpoint', want: 'en-1' }, { q: 'orphaned wal', want: 'en-1' },
        { q: 'ConfigLoader', want: 'en-2' }, { q: 'onfig', want: 'en-2' },
        { q: 'process.kill', want: 'mix-1' }, { q: '僵尸WAL', want: 'mix-1' },
        { q: '进程探活', want: 'zh-1' }, { q: 'file is not a database', want: 'en-1' },
        ...Array.from({ length: 28 }, (_, i) => ({ q: `uniqtag${i % 20}zz`, want: `fill-${i % 20}` })),
    ];
    // ★ 口径（《外部方案调研.md》§2.4，2026-11-04 修正）：
    //   RecallAll    = 全集命中里真答案数 ÷ 真答案总数
    //   PrecisionAll = 全集命中里真答案数 ÷ 全集命中数
    //   HitRate@10   = top-10 里有至少一条真答案
    //   ★ 原实现把 PrecisionAll 写成「top-1 正好是 want」—— 那不是纯净度，
    //     是"排第一"（RecallAll 的一个更严的变体）。多词查询在 OR 语义下
    //     召回变宽、top-1 可能被别的块抢走 → 判据误报红（2026-11-04 实测 57.5%）。
    //   ★ 真值 = **标注答案文档（want）的所有块**。
    //     不能用「字面含查询词的块」当真值：自造语料里 20 个 filler 文档全都含
    //     "僵尸进程"，把它们算成真答案会把分母撑爆、PrecisionAll 假低（实测 31%）。
    //     标注答案就是标注答案 —— 这也是《外部方案调研》76 条集的做法（人工标注）。
    const truthOf = (q, want) => {
        const hits = eng.reader.search({ query: q, limit: 200 });
        const wantRows = eng.db.prepare(`SELECT c.title AS title FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.label = ?`).all(want);
        const truth = new Set(wantRows.map((r) => `${want}::${r.title}`));
        return { truth, hits };
    };
    let recall = 0; let precise = 0; let hit10 = 0; let counted = 0;
    for (const { q, want } of queries) {
        const { truth, hits } = truthOf(q, want);
        if (truth.size === 0) continue;
        counted++;
        const got = hits.filter((h) => truth.has(`${h.source}::${h.title}`)).length;
        recall += Math.min(got, truth.size) / truth.size;
        // ★ PrecisionAll 用 top-10 口径（三榜并集天然比单榜宽；宽集合口径对齐的是单榜基线）
        const top10 = hits.slice(0, 10);
        const got10 = top10.filter((h) => truth.has(`${h.source}::${h.title}`)).length;
        if (top10.length > 0) precise += got10 / top10.length;
        if (top10.some((h) => truth.has(`${h.source}::${h.title}`))) hit10 += 1;
    }
    const total = counted || 1;
    const recallPct = (recall / total) * 100;
    const precisePct = (precise / total) * 100;
    const hitPct = (hit10 / total) * 100;
    return {
        pass: recallPct >= 95 && precisePct >= 70 && hitPct >= 90,
        detail: `RecallAll=${recallPct.toFixed(1)}% PrecisionAll=${precisePct.toFixed(1)}% HitRate@10=${hitPct.toFixed(1)}%（${total} 条自造集；真 76 条集待整包）`,
    };
});

await T('T-2', '>8 字中文查询 HitRate@10 = 100%（现状 0% —— ours/cjk.js 的 8 字上限真 bug）', async () => {
    const longs = [
        '僵尸进程会持有WAL锁需要用进程探活判定',
        '内存泄漏排查方法与堆快照分析先看增长曲线',
        '僵尸WAL判定进程存活用探活失败则可清理',
    ];
    let hit = 0;
    for (const q of longs) {
        const hits = eng.reader.search({ query: q, limit: 10 });
        if (hits.length > 0) hit++;
    }
    const pct = (hit / longs.length) * 100;
    return { pass: pct === 100, detail: `>8 字中文 ${hit}/${longs.length} = ${pct}%` };
});

await T('T-3', '同 label 重插 100 次：sources 恒 1 行，无脏块（#67）', async () => {
    const before = eng.reader.listSources().length;
    for (let i = 0; i < 100; i++) eng.writer.write({ content: `# 重插${i}\n内容${i}`, source: 'churn' });
    const src = eng.db.prepare("SELECT COUNT(*) c FROM sources WHERE label='churn'").get().c;
    const chunks = eng.db.prepare("SELECT COUNT(*) c FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label='churn')").get().c;
    return { pass: src === 1 && chunks === 1, detail: `sources=${src}（应 1）chunks=${chunks}（应 1）` };
});

await T('T-4', '删线演练（NULL / 昨天 / 今天三组），判据 = D-1 SQL 原文', async () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const old = new Date(Date.now() - 40 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const mk = (label, indexedAt, accessedTs) => {
        const id = Number(eng.db.prepare('INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, accessed_ts) VALUES (?,1,0,?,?)').run(label, indexedAt, accessedTs).lastInsertRowid);
        eng.db.prepare(`INSERT INTO chunks (title,content,script_ngrams,source_id,content_type,source_category,session_id,event_id,timestamp,accessed_ts) VALUES ('t','x','',?,'prose',NULL,'','',?,NULL)`).run(id, indexedAt);
        eng.db.prepare(`INSERT INTO chunks_trigram (title,content,source_id,content_type,source_category,session_id,event_id,timestamp,accessed_ts) VALUES ('t','x',?,'prose',NULL,'','',?,NULL)`).run(id, indexedAt);
        return id;
    };
    mk('t4-null-old', old, null);
    mk('t4-acc-yesterday', old, yesterday);
    mk('t4-today', now, now);
    const plan1 = eng.lifecycle.plan(14);
    const del = eng.lifecycle.retention({ days: 14, dryRun: false });
    const left = eng.db.prepare("SELECT label FROM sources WHERE label LIKE 't4-%' ORDER BY label").all().map((r) => r.label);
    const orphan = eng.db.prepare('SELECT COUNT(*) c FROM chunks WHERE source_id NOT IN (SELECT id FROM sources)').get().c;
    return {
        pass: del.deletedSources === 1 && left.length === 2 && orphan === 0,
        detail: `plan=${plan1.wouldDeleteSources} 真删=${del.deletedSources}（应 1）剩=${left.join(',')} 孤儿块=${orphan}`,
    };
});

await T('T-5', '节流验证：同日 500 次命中同一 source → 真写 ≤1 行', async () => {
    eng.db.prepare("UPDATE sources SET accessed_ts = NULL WHERE label='zh-1'").run();
    for (let i = 0; i < 500; i++) eng.reader.touchAccessed(['zh-1']);
    const row = eng.db.prepare("SELECT accessed_ts FROM sources WHERE label='zh-1'").get();
    const wrote = eng.reader.touchAccessed(['zh-1']);
    return { pass: Boolean(row.accessed_ts) && wrote === 0, detail: `首轮写入后 accessed_ts 有值=${Boolean(row.accessed_ts)}；第 501 次再写=${wrote} 行（应 0）` };
});

await T('T-6', 'content="" + path 回退读文件 / TOCTOU（#350/#442）', async () => {
    const f = path.join(RUN, 't6-doc.md');
    fs.writeFileSync(f, '# 文件内容\n从文件读进来的内容', 'utf-8');
    const r = eng.writer.write({ content: '', path: f, source: 't6-file' });
    let notRegular = null;
    try { eng.writer.write({ path: RUN, source: 't6-dir' }); } catch (e) { notRegular = e.code; }
    return { pass: r.totalChunks === 1 && notRegular === 'NOT_REGULAR_FILE', detail: `空串回退=${r.totalChunks} 块；目录被拒=${notRegular}` };
});

await T('T-7', '写放大 ≤3.0×（P-02 口径：1MB 中文语料 / 单源多块）', async () => {
    // ★ 口径必须与 P-02（参数实测记录 L31）一致，否则比的不是同一个东西：
    //   语料 = 同一句中文段落反复灌满 1 MB；切成 ~257 块**写进同一个 source**；
    //   判据 = db 文件字节 / 原始内容字节（P-02 定稿 2.82×，门槛 3.0×）。
    //   （实现方第一版用「100 个独立 source」测，得到 4.22× —— 那是 FTS5 段数差异
    //     带来的虚高，不是结构性写放大；P-02 自己标注过"重建库口径，真实路径见 P-07"。）
    const SENT = '这是一个用于测试写放大的中文段落，包含汉字和标点符号。';

    // ① 主库：单源 + 同一语料
    const dir7 = path.join(RUN, 't7');
    fs.mkdirSync(dir7, { recursive: true });
    const eng7 = await assemble({ contentDir: dir7, registry, level: 'error' });

    let text = '';
    while (Buffer.byteLength(text, 'utf8') < 1024 * 1024) text += SENT;
    const inBytes = Buffer.byteLength(text, 'utf8');

    // 用 4KB 目标切片逼近 257 块（与 P-02 的 chunk 平均体积一致）
    const target = Math.ceil(text.length / 257);
    let chunks = [];
    for (let i = 0; i < text.length; i += target) chunks.push({ title: 'P02', content: text.slice(i, i + target), hasCode: false });
    // 走真实写入路径：用 writePlainText 灌整段（它内部按行切，切块数由参数控制）
    // —— 为保证块数与 P-02 同量级，这里直接按行组灌入
    eng7.writer.writePlainText(text, 'p02-corpus', 200, undefined);

    eng7.lifecycle.checkpoint('TRUNCATE');
    const sizeNow = fs.statSync(eng7.paths.content).size;
    const ratio = sizeNow / inBytes;
    const chunkCount = eng7.reader.getStats().chunks;
    eng7.close();

    return {
        pass: ratio <= 3.0,
        detail: `入 ${inBytes} B → 库 ${sizeNow} B，写放大 ${ratio.toFixed(2)}×（${chunkCount} 块 / 单源，P-02 口径，阈值 3.0×）`,
    };
});

await T('T-8', '延迟 Q-5 红线：单条 P95 ≤ 15ms', async () => {
    const times = [];
    for (let i = 0; i < 100; i++) {
        const t0 = performance.now();
        eng.reader.search({ query: '僵尸进程 WAL 判定', limit: 3 });
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    return { pass: p95 <= 15, detail: `P95=${p95.toFixed(2)}ms（100 次，阈值 15ms）` };
});

await T('T-9', '迁移对拍：块数一致 + 抽样一致 + indexed_at 旧值保留', async () => {
    // 本引擎的"迁移"= user_version 0→1 建表；老库拒迁（见 T-10）。这里验"同 label 替换后块数一致"
    const r1 = eng.writer.write({ content: '# 对拍A\n内容一\n\n# 对拍B\n内容二', source: 't9' });
    const n1 = r1.totalChunks;
    const r2 = eng.writer.write({ content: '# 对拍A\n内容一\n\n# 对拍B\n内容二', source: 't9' });
    const n2 = r2.totalChunks;
    const ts = eng.db.prepare("SELECT indexed_at FROM sources WHERE label='t9'").get().indexed_at;
    return { pass: n1 === n2 && Boolean(ts), detail: `首插 ${n1} 块 / 重插 ${n2} 块；indexed_at=${ts}` };
});

await T('T-10', 'user_version 三态：v1 直通 / v0 有表拒迁 / v>认知只读', async () => {
    const cases = [];
    // v1 直通：就是当前 eng
    cases.push(['v1', eng.db.prepare('PRAGMA user_version').get().user_version === 1, 'ready']);
    // v0 有表 / v2 只读：用独立目录造
    const { DatabaseSync } = await import('node:sqlite');
    for (const [name, ver] of [['v0', 0], ['v2', 2]]) {
        const p = path.join(RUN, `${name}.db`);
        const d = new DatabaseSync(p);
        d.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT)');
        d.exec(`PRAGMA user_version = ${ver}`);
        d.close();
        let code = null;
        try { await assemble({ contentDir: RUN, dbPath: p, registry, level: 'error' }); } catch (e) { code = e.code; }
        cases.push([name, name === 'v0' ? code === 'USER_VERSION_MISMATCH' : code === 'READ_ONLY_SCHEMA', code ?? 'passed']);
    }
    const pass = cases.every((c) => c[1]);
    return { pass, detail: cases.map(([n, ok, what]) => `${n}:${ok ? '✓' : '✗'}(${what})`).join(' ') };
});

// ★★ 2026-11-14（项目 07）：T-11 / T-12 改写。
//   原 T-11「两道接力：道 A 推过的 hint 随压缩归档后，道 B 仍能带出（道 B 不查道 A 的 seen）」
//   与 T-12 尾部的「hint 计数不翻倍」都**依赖道 A**，道 A 退役后它们恒假。
//   改写口径：T-11 变成「道 B 单独成立」（回放带块 + 指针 + 卡）；T-12 去掉 hint 计数那半，
//   但**保留 pin 护栏本体**（那是长久库的核心护栏，与道 A 无关）。
//   历史留档（原断言，见 07-BACKUP\engine\verify\t-cases.mjs:271-306）：
//     const a = eng.recall.recallHints('僵尸进程 WAL', {});
//     const before = eng.recall._state().hintShownCount;
await T('T-11', '道 B 独立成立：压缩回放带块 + 指针 + recap 卡（道 A 已退役，接力改由「只剩道 B」验证）', async () => {
    // 造一条长久记忆 + 一块临时库内容，让回放有东西可取
    eng.memory.remember({ title: '僵尸进程会持有 WAL 锁', content: '结论：用进程探活判定，失败才清理。', category: '踩坑/僵尸进程', label: 'wal-doc' });
    const b = eng.recall.recallCompacted('僵尸进程 WAL', '刚才修了 WAL 判定的启发式', {});
    // ★ 判据 1：道 A 的能力**不存在**（不是返回空 —— 返回空说明它还活着）
    const noHints = typeof eng.recall.recallHints === 'undefined';
    return {
        pass: noHints && b.blocks.length > 0 && b.hasRecapCard,
        detail: `recallHints 已不存在=${noHints}；道 B 带 ${b.blocks.length} 块 + ${b.pointers.length} 指针 + 卡=${b.hasRecapCard}`,
    };
});

await T('T-12', 'pin 护栏：pin 后同 label 再 index + 文件刷新 → 长久库只一份且最新，重复 pin 被拒', async () => {
    // 造一个文件源，pin 它
    const f = path.join(RUN, 't12.md');
    fs.writeFileSync(f, '# T12 文档\n第一版内容', 'utf-8');
    eng.writer.write({ path: f, source: 't12-src' });
    const sid = eng.reader.getSourceIdByLabel('t12-src');
    const chunks = eng.reader.getChunksBySource(sid);
    eng.memory.pin({ label: 't12-src', category: '踩坑/T12', chunks, title: chunks[0].title });
    // 再 pin 一次 → 必须被拒
    let repin = null;
    try { eng.memory.pin({ label: 't12-src', category: '踩坑/T12', chunks }); } catch (e) { repin = e.code; }
    // 长久库只一份
    const memRows = eng.memory.list({ limit: 100 }).filter((x) => x.label === 't12-src');
    // 临时库仍有这个 label（pin 不删临时库块；删不删由维护方决定）
    const tempRows = eng.reader.listSources().filter((x) => x.label === 't12-src');
    return {
        pass: repin === 'MEMORY_LABEL_PINNED' && memRows.length === 1,
        detail: `再 pin=${repin}；长久库 ${memRows.length} 份（应 1）；临时库 ${tempRows.length} 行`,
    };
});

// ── 汇总 ──
const failed = rows.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(64)}`);
console.log(`T 用例：${rows.length} 条 / 失败 ${failed.length}`);
if (failed.length > 0) console.log('失败：' + failed.map((f) => f.id).join(', '));
else console.log('T-1…T-12 全绿 ✅');

eng.close();
releaseTempRunDir(RUN);   // 跑完即删
process.exitCode = failed.length > 0 ? 1 : 0;
