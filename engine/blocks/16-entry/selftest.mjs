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
 * 16-entry/selftest.mjs — 单跑必绿（G7 的一部分：三种入口里的"进程内装配"）
 *
 * 测什么：① fresh 库能装起来、user_version=1 ② v0 有表 → 拒迁（不静默删库）
 *        ③ v>认知 → 只读报警 ④ write→read→stats 全链通 ⑤ close 不 leak
 *        ⑥ 装配后 13 个 op 都能调
 */
import assert from 'node:assert/strict';
import { makeTempRunDir } from '../../libs/tempdir.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assemble } from './index.js';
import { createRegistry } from '../../registry.mjs';

const dir = makeTempRunDir('entry');
function cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const registry = createRegistry({ level: 'error' });

    const eng = await assemble({ contentDir: dir, registry, level: 'error' });

    await t('① fresh 库装起来：user_version=1、两库文件都在', () => {
        assert.equal(eng.state, 'fresh');
        const uv = eng.db.prepare('PRAGMA user_version').get().user_version;
        assert.equal(uv, 1);
        assert.ok(fs.existsSync(eng.paths.content), '内容库没建');
        assert.ok(fs.existsSync(eng.paths.memory), '长久库没建');
    });

    await t('② 写入 → 查询 → 统计 全链通（真写真搜）', () => {
        eng.writer.write({ content: '# 僵尸进程\nWAL 锁需要进程探活判定。', source: 'doc1' });
        const hits = eng.reader.search({ query: '僵尸进程', limit: 3 });
        assert.ok(hits.length > 0, '查不到刚写的内容');
        assert.ok(hits[0].content.includes('僵尸'), hits[0].content.slice(0, 30));
        const st = eng.reader.getStats();
        assert.ok(st.sources >= 1 && st.chunks >= 1, JSON.stringify(st));
    });

    // ★ 2026-11-09 ④步 CTX 净身：14 → 13（op:search 迁 FP，净身版 §三-3 第 5 处延伸）。
    //   净身版 §三-4 的"禁连坐"清单未点到本文件，属**账外漏项**，本窗施工中现抓，已记开发日志。
    await t('③ 13 个 op 都能调（tools 装配完整）', () => {
        assert.equal(eng.tools.ops().length, 13);
        for (const op of eng.tools.ops()) assert.ok(eng.tools.get(op), `缺 op ${op}`);
    });

    // ★ 2026-11-09 净身：用例名原写 "op=index → op=search 往返"，但函数体从来不调 search
    //   （只 index 再 list），名实不符历史遗留；search 迁走后名里再挂 search 就是撒谎，一并正名。
    await t('④ op=index 写入 → list 自描述表 13 行（走 16-entry 的 call 中转）', async () => {
        await eng.call('index', { content: '# 配置\nConfigLoader 读取字段', source: 'doc2' });
        const r = await eng.call('list', {});
        assert.equal(r.result.length, 13);
    });

    await t('⑤ op=remember 写长久库', async () => {
        const r = await eng.call('remember', { title: '结论一', content: '这段要长期留着', category: '结论/甲' });
        assert.ok(r.result.id > 0);
        const list = await eng.call('memory', { action: 'list' });
        assert.ok(list.result.some((x) => x.title === '结论一'));
    });

    await t('⑥ stats 汇总包含 memory；hints 只有注入了真池（道 B）才报', async () => {
        const r = await eng.call('stats', {});
        assert.ok(r.result.db && r.result.memory, JSON.stringify(r.result).slice(0, 120));
        // ★★ 2026-11-14（项目 07）：道 A 退役后，`hints` 不再回退读死池 ——
        //   引擎独立跑（本门就是独立跑）没有注入 `hintState`，所以这一格应当不存在。
        //   历史：修前这里断言 `hints` 必在，靠的是 `deps.recall._state()` 那个恒 0 死池。
        assert.equal(r.result.hints, undefined, 'hints 在独立跑的引擎里出现了 —— 回退读死数的口被复活');
    });

    await t('⑦ close 后句柄都关了（再写会报库已关）', () => {
        eng.close();
        assert.throws(() => eng.db.prepare('SELECT 1').get(), /database is not open|not open/i);
    });

    // ── 三态护栏（用独立目录，别污染上面那个） ──
    const dirV0 = path.join(dir, '..', `entry-v0-${process.pid}`);
    await t('⑧ v0 有表 → 拒迁（不许静默重建=不许静默删库）', async () => {
        fs.rmSync(dirV0, { recursive: true, force: true });
        fs.mkdirSync(dirV0, { recursive: true });
        const p = path.join(dirV0, 'legacy.db');
        const legacy = new DatabaseSync(p);
        legacy.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT)');
        legacy.exec('PRAGMA user_version = 0');
        legacy.close();
        let threw = null;
        try { await assemble({ contentDir: dirV0, dbPath: p, registry, level: 'error' }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'USER_VERSION_MISMATCH', `实际 ${threw?.code}`);
        assert.ok(fs.existsSync(p), '老库文件被删了 —— 静默删库');
        fs.rmSync(dirV0, { recursive: true, force: true });
    });

    const dirV2 = path.join(dir, '..', `entry-v2-${process.pid}`);
    await t('⑨ v>认知 → 只读报警', async () => {
        fs.rmSync(dirV2, { recursive: true, force: true });
        fs.mkdirSync(dirV2, { recursive: true });
        const p = path.join(dirV2, 'future.db');
        const fut = new DatabaseSync(p);
        fut.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT)');
        fut.exec('PRAGMA user_version = 2');
        fut.close();
        let threw = null;
        try { await assemble({ contentDir: dirV2, dbPath: p, registry, level: 'error' }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'READ_ONLY_SCHEMA', `实际 ${threw?.code}`);
        fs.rmSync(dirV2, { recursive: true, force: true });
    });

    await t('⑩ 未装配的 op 调用 → UNKNOWN_OP（可读）', async () => {
        const e2 = await assemble({ contentDir: path.join(dir, 'x'), registry, level: 'error' });
        const r = [];
        try { await e2.call('nope', {}); } catch (e) { r.push(e); }
        assert.equal(r[0]?.code, 'UNKNOWN_OP', `实际 ${r[0]?.code}`);
        e2.close();
    });

    // ── 2026-11-04 P3 九条判据（防止"看起来有、实际调不通"回退）──

    await t('⑪ ★#17 03-storage 进装配路径（拿到 withRetry/TRUNCATE checkpoint/孤儿 WAL 清理）', async () => {
        const e = await assemble({ contentDir: path.join(dir, 'storage-path'), registry, level: 'error' });
        // 拿到 storage 句柄 = 走的是 openDB（不是裸 new DatabaseSync）
        assert.ok(e.handle, '没拿到 03-storage 的句柄 —— 还在裸开库');
        assert.equal(typeof e.handle.close, 'function', '句柄没有 close（拿不到 TRUNCATE checkpoint）');
        // 句柄 close 内部会 checkpoint（写成 close 后 -wal 应被清/缩）
        const walPath = `${e.paths.content}-wal`;
        e.close();
        let walBytes = 0;
        try { walBytes = fs.statSync(walPath).size; } catch { walBytes = 0; }
        assert.ok(walBytes === 0, `close 后 -wal 还有 ${walBytes} B（TRUNCATE checkpoint 没生效）`);
    });

    await t('⑫ ★#16 启动 14 天删线真跑（30 天前的 source 重开后不在）', async () => {
        const d2 = path.join(dir, 'startup-retention');
        fs.mkdirSync(d2, { recursive: true });
        const e1 = await assemble({ contentDir: d2, registry, level: 'error' });
        e1.writer.write({ content: '# 老东西\n内容', source: 'old-30d' });
        e1.db.prepare("UPDATE sources SET indexed_at = datetime('now','-30 days'), accessed_ts = NULL WHERE label='old-30d'").run();
        e1.close();
        const e2 = await assemble({ contentDir: d2, registry, level: 'error' });
        const left = e2.db.prepare("SELECT label FROM sources WHERE label='old-30d'").get();
        assert.equal(left, undefined, '30 天前的 source 还在 —— 启动删线没跑');
        assert.equal(e2.startupRetention?.dryRun, false, '启动删线必须是真删（dryRun:false）');
        e2.close();
    });

    await t('⑬ ★#12 op:purge 真可用（不再报"实现未注入"）', async () => {
        const d3 = path.join(dir, 'purge');
        fs.mkdirSync(d3, { recursive: true });
        const e = await assemble({ contentDir: d3, registry, level: 'error' });
        e.writer.write({ content: '# 待清\n内容', source: 'to-purge' });
        const dry = await e.tools.get('purge').call({ scope: 'source', source: 'to-purge' });
        assert.equal(dry.result.dryRun, true, '默认必须干跑');
        const real = await e.tools.get('purge').call({ scope: 'source', source: 'to-purge', dryRun: false });
        assert.equal(real.result.dryRun, false);
        assert.equal(e.db.prepare("SELECT COUNT(*) c FROM sources WHERE label='to-purge'").get().c, 0, 'purge 没删掉');
        e.close();
    });

    await t('⑭ ★#13 op:index 支持目录（dir 键在 schema 里且真能用）', async () => {
        const d4 = path.join(dir, 'dir-index');
        const docsDir = path.join(d4, 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'a.md'), '# 甲\n内容甲');
        fs.writeFileSync(path.join(docsDir, 'b.md'), '# 乙\n内容乙');
        const e = await assemble({ contentDir: d4, registry, level: 'error' });
        const r = await e.tools.get('index').call({ dir: docsDir, source: 'docs', sessionId: 'S1' });
        assert.ok(r.result.filesIndexed >= 2, `只写了 ${r.result.filesIndexed} 个文件（应 ≥2）`);
        assert.equal(r.result.failed, 0, `${r.result.failed} 个失败：${r.result.failures?.join(' / ')}`);
        // label 用相对路径（2.0 口径），不是绝对路径
        const labels = e.db.prepare("SELECT label FROM sources WHERE label LIKE 'docs:%'").all().map((x) => x.label);
        assert.ok(labels.length >= 2, JSON.stringify(labels));
        // ★ 只判"不该有的绝对路径"：**临时目录本身**的绝对路径是允许的
        //   （label 形如 docs:<dir>\a.md，dir 在临时目录下）。
        //   判据真正要抓的是"label 里混进了绝对路径"——那会让 label 不可移植。
        //   所以：去掉临时目录前缀后，不许再出现盘符路径。
        const tmpRoot = path.resolve(dir);
        for (const l of labels) {
            const withoutTmp = l.split(tmpRoot).join('');
            assert.ok(!/[A-Za-z]:\\/.test(withoutTmp),
                `label 里出现了绝对路径（临时目录之外）：${l}`);
        }
        e.close();
    });

    await t('⑮ ★#14/#15 op:index 的 category 与 pin:true 真落值', async () => {
        const d5 = path.join(dir, 'cat-pin');
        fs.mkdirSync(d5, { recursive: true });
        const e = await assemble({ contentDir: d5, registry, level: 'error' });
        await e.tools.get('index').call({ content: '# 分类\n正文', source: 'cat-test', category: '库重写/验证/pitfall' });
        const row = e.db.prepare("SELECT DISTINCT source_category FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label='cat-test')").get();
        assert.equal(row?.source_category, '库重写/验证/pitfall', `category 没落值：${JSON.stringify(row)}`);
        const p = await e.tools.get('index').call({ content: '# 钉\n正文', source: 'pin-test', category: '协作/测试', pin: true });
        assert.ok(p.result.pinned, 'pin:true 没有产出长久库行');
        assert.ok(e.memory.list({ limit: 20 }).some((m) => m.label === 'pin-test'), '长久库里没有 pin-test');
        e.close();
    });

    await t('⑯ ★#18 M-3 完整性抽检在位（500 次间隔 + 失败只报警）', async () => {
        const d6 = path.join(dir, 'integrity');
        fs.mkdirSync(d6, { recursive: true });
        const e = await assemble({ contentDir: d6, registry, level: 'error' });
        const st = e.writer.integrityState();
        assert.equal(st.every, 500, `抽检间隔应为 500，实际 ${st.every}`);
        assert.equal(st.failing, false, '新库不该是 failing');
        const probe = e.writer.integrityProbe();
        assert.equal(probe.ok, true, `抽检失败：${probe.sqlite} / ${probe.fts5}`);
        e.close();
    });

    await t('⑰ ★#19 M-7 统计三项（user_version / wal_bytes / accessed_today）', async () => {
        const d7 = path.join(dir, 'stats-m7');
        fs.mkdirSync(d7, { recursive: true });
        const e = await assemble({ contentDir: d7, registry, level: 'error' });
        const out = await e.tools.get('stats').call({});
        const db = out.result.db;
        for (const k of ['user_version', 'wal_bytes', 'accessed_today']) {
            assert.ok(k in db, `getStats 缺 ${k}：${JSON.stringify(db)}`);
        }
        e.close();
    });

    // ★ 2026-11-09 ④步 CTX 净身：原 ⑱「op:search 未装配时报 WEB_NOT_MOUNTED」**整条退役**。
    //   被测对象（`tools.get('search')` 及其错误面）已随 op:search 整条迁 FP，CTX 侧
    //   `get('search')` 返回 undefined ⇒ 本用例不再是"测行为"，而是"测一个不存在的 op"（假红）。
    //   按净身版 §三-10/§三-16 同族口径处理：**采退役不采改判**（改判=让门去查 CTX 已不存在的件）。
    //   覆盖转移账（不粉饰）：CTX 侧"web 未装配 → WEB_NOT_MOUNTED 可读文案"这条回归**归零随迁 FP**；
    //   FP 须自建等价门（含当时的两条文案判据：要点名 recall 类的指路、不许复用 index 的参数文案）。
    //   历史价值留档（原件在 BACKUP\engine\blocks\16-entry\selftest.mjs）：这条是 P3 #20 的产物——
    //   原来报 NO_INPUT 且文案指向 index 的参数（"至少给一个输入：path/content/url"），
    //   模型照着改参数只会继续撞墙；根因是"搜索模块没装配 = 这条路没装，不是参数给错了"。


    console.log(`\n16-entry: ${n} 项全绿`);
}
catch (e) {
    console.error('16-entry selftest 失败：', e.message, '\n', e.stack?.split('\n').slice(0, 3).join('\n'));
    process.exitCode = 1;
}
finally { cleanup(); }
