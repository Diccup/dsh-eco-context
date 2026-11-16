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
 * 11-memory/selftest.mjs — 单跑必绿（临时库落 Temp，跑完自删）
 *
 * 测什么：① category 路径校验三态 ② 64KB 闸 ③ pin 合并一行 ④ 已 pin 护栏（T-12 前提）
 *        ⑤ unpin 交回内容 ⑥ list 不带正文 ⑦ setCategory/delete ⑦ 懒创建目录
 */
import assert from 'node:assert/strict';
import { makeTempRunDir } from '../../libs/tempdir.js';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDB, createMemory, validateCategory, MEMORY_DDL } from './index.js';

const dir = makeTempRunDir('memory');
const dbPath = path.join(dir, 'x.persistent.db');
function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
    fs.mkdirSync(dir, { recursive: true });
    const db = openMemoryDB(dbPath);   // 顺带测懒创建
    const m = createMemory({ db });
    let n = 0;
    const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

    t('① 懒创建：目录与库文件都被建出来了', () => {
        assert.ok(fs.existsSync(dbPath), '库文件没建出来');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
        assert.ok(tables.includes('memory'), `${tables}`);
    });

    t('② memory 表无 FTS5（长久库存总结不存仓库）', () => {
        const virt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'").all();
        assert.equal(virt.length, 0, `出现了 FTS5 表：${virt.map((x) => x.name)}`);
    });

    t('③ category 合法：1/2/3 段都过，4 段被拒', () => {
        assert.equal(validateCategory('踩坑'), '踩坑');
        assert.equal(validateCategory('踩坑/僵尸进程'), '踩坑/僵尸进程');
        assert.equal(validateCategory('踩坑/僵尸进程/判定'), '踩坑/僵尸进程/判定');
        let threw = null;
        try { validateCategory('a/b/c/d'); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_CATEGORY_INVALID');
    });

    t('④ category 段内空格被拒（并列出既有路径）', () => {
        let threw = null;
        try { validateCategory('踩 坑'); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_CATEGORY_INVALID');
    });

    t('⑤ 64KB 闸：刚好 64KB 过，超 1 字节拒收（不截断）', () => {
        const ok = 'x'.repeat(65536);
        const r = m.remember({ title: '边界值', content: ok, category: '边界/64K' });
        assert.ok(r.id > 0);
        let threw = null;
        try { m.remember({ title: '超界', content: 'x'.repeat(65537), category: '边界/64K' }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_TOO_BIG');
        // 拒收后没有任何新行
        assert.equal(m.stats().rows, 1);
    });

    t('⑥ remember 同 label 覆盖（不新增行）', () => {
        m.remember({ title: '结论A', content: '第一版', category: '结论/甲', label: 'conclusion:A' });
        const before = m.stats().rows;
        const r2 = m.remember({ title: '结论A', content: '第二版', category: '结论/甲', label: 'conclusion:A' });
        assert.equal(r2.updated, true);
        assert.equal(m.stats().rows, before, '行数变了（应覆盖）');
        const row = m.get(r2.id);
        assert.equal(row.content, '第二版');
    });

    t('⑦ pin：多块按序合并成一行', () => {
        const r = m.pin({
            label: 'wal-doc',
            category: '踩坑/僵尸进程',
            chunks: [{ title: 'T1', content: '块一' }, { title: 'T2', content: '块二' }, { title: 'T3', content: '块三' }],
        });
        assert.equal(r.fromChunks, 3);
        const row = m.get(r.id);
        assert.equal(row.content, '块一\n\n块二\n\n块三');
        assert.equal(row.label, 'wal-doc');
    });

    t('⑧ 已 pin 护栏：同 label 再 pin → 拒收（T-12 的 hint 计数不翻倍前提）', () => {
        let threw = null;
        try {
            m.pin({ label: 'wal-doc', category: '踩坑/僵尸进程', chunks: [{ title: 'T', content: '再来一次' }] });
        }
        catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_LABEL_PINNED', `实际 ${threw?.code}`);
        assert.equal(m.get(threw.details ? m.list().find((x) => x.label === 'wal-doc').id : 0).content, '块一\n\n块二\n\n块三');
    });

    t('⑨ pin 体积闸：合并后 >64KB 拒收（长久库存总结不存仓库）', () => {
        let threw = null;
        try {
            m.pin({ label: 'big-doc', category: '踩坑/大文件', chunks: [{ title: 'B', content: 'y'.repeat(70000) }] });
        }
        catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_TOO_BIG');
    });

    t('⑩ unpin：内容交回 + 行删除', () => {
        const r = m.unpin({ label: 'wal-doc' });
        assert.equal(r.released, true);
        assert.equal(r.content, '块一\n\n块二\n\n块三');
        assert.equal(m.list().find((x) => x.label === 'wal-doc'), undefined, 'unpin 后行还在');
    });

    t('⑪ unpin 不存在的 label → 可读错误', () => {
        let threw = null;
        try { m.unpin({ label: 'nope' }); } catch (e) { threw = e; }
        assert.ok(threw && threw.message.includes('长久库没有'));
    });

    t('⑫ list 永不自动带正文', () => {
        const rows = m.list({ limit: 10 });
        assert.ok(rows.length > 0);
        for (const r of rows) assert.equal('content' in r, false, 'list 带正文了');
        assert.ok(rows[0].category && rows[0].label);
    });

    t('⑬ setCategory 与 remember 同校验', () => {
        const rows = m.list({ limit: 1 });
        const r = m.setCategory({ id: rows[0].id, category: '新类/子类' });
        assert.equal(r.category, '新类/子类');
        let threw = null;
        try { m.setCategory({ id: rows[0].id, category: 'a b' }); } catch (e) { threw = e; }
        assert.equal(threw?.code, 'MEMORY_CATEGORY_INVALID');
    });

    t('⑭ delete 是唯一允许删长久记忆的入口', () => {
        const rows = m.list({ limit: 1 });
        const r = m.remove({ id: rows[0].id });
        assert.equal(r.deleted, true);
        assert.equal(m.get(rows[0].id), null);
    });

    t('⑮ stats 报字节与类目', () => {
        const s = m.stats();
        assert.ok(s.rows > 0 && s.bytes > 0 && s.limit === 65536);
        assert.ok(Array.isArray(s.categories));
    });

    console.log(`\n11-memory: ${n} 项全绿`);
    m.close();
}
catch (e) {
    console.error('11-memory selftest 失败：', e.message);
    process.exitCode = 1;
}
finally { cleanup(); }
