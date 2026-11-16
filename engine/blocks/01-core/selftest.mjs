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
 * 01-core/selftest.mjs — 单跑即绿：node blocks\01-core\selftest.mjs
 *
 * 覆盖任务书 A §二·01-core 的三条要求：
 *   ① userVersionState 四种输入全断言（S-2 唯一判据）
 *   ② 12 个执行语言一个不少
 *   ③ DEFAULTS 每个值都是 number
 * 额外：SCRIPT_EXT 与 EXEC_LANGUAGES 键一一对应（13-sandbox 靠这条不裸奔）。
 */

import assert from 'node:assert/strict';
import { NAME, DEFAULTS, EXEC_LANGUAGES, SCRIPT_EXT, SCHEMA_STATES, userVersionState, init } from './index.js';
import { SCHEMA_VERSION } from '../../libs/sql.js';
import meta from './meta.js';

let n = 0;
async function ok(label, fn) {
    await fn();
    n++;
    console.log(`  ✓ ${label}`);
}
// 顶层按序 await：异步用例没跑完就绿 = 假绿，所以每条调用都必须 await。

console.log(`[selftest] ${NAME}`);

await ok('块名与 meta 对齐（name=core, kind=contract, deps=[]）', () => {
    assert.equal(NAME, 'core');
    assert.equal(meta.name, 'core');
    assert.equal(meta.kind, 'contract');
    assert.deepEqual(meta.deps, []);
});

await ok(`userVersionState: v=${SCHEMA_VERSION} → ready（定稿结构直通）`, () => {
    assert.equal(userVersionState(SCHEMA_VERSION, 0), 'ready');
    assert.equal(userVersionState(SCHEMA_VERSION, 4), 'ready');
});

await ok('userVersionState: v=0 且有表 → refuse-v0-with-tables（拒迁）', () => {
    assert.equal(userVersionState(0, 1), 'refuse-v0-with-tables');
    assert.equal(userVersionState(0, 42), 'refuse-v0-with-tables');
});

await ok('userVersionState: v=0 且空库 → fresh（正常建）', () => {
    assert.equal(userVersionState(0, 0), 'fresh');
});

await ok(`userVersionState: v>${SCHEMA_VERSION} → read-only（认知外只读报警）`, () => {
    assert.equal(userVersionState(SCHEMA_VERSION + 1, 4), 'read-only');
    assert.equal(userVersionState(99, 0), 'read-only');
    assert.equal(userVersionState(-1, 3), 'read-only'); // 异常负值也不写
});

await ok(`userVersionState: 旧版 v1（< ${SCHEMA_VERSION}）→ 不是 ready（旧形态不许直通）`, () => {
    // ★ 2026-11-04 事故回归：v1 库曾因 SCHEMA_VERSION 没升而被判 read-only，
    //   反过来，现在 v1 也不该被当成 ready —— 它的 tokenizer/trigram 形态与 v2 不同，
    //   直通会静默用错结构。必须走迁移脚本升 v2。
    if (SCHEMA_VERSION > 1) {
        assert.notEqual(userVersionState(1, 4), 'ready', 'v1 不许直通，要走迁移');
    }
});

await ok('四态互斥且与 SCHEMA_STATES 一字不差', () => {
    const seen = new Set([
        userVersionState(SCHEMA_VERSION, 1),
        userVersionState(0, 1),
        userVersionState(0, 0),
        userVersionState(SCHEMA_VERSION + 1, 1),
    ]);
    assert.equal(seen.size, 4, '四态必须互不相同');
    assert.deepEqual([...seen].sort(), Object.values(SCHEMA_STATES).sort());
});

await ok('userVersionState 弱类型入参直接 throw（不静默转型）', () => {
    assert.throws(() => userVersionState('1', 0), TypeError);
    assert.throws(() => userVersionState(1, undefined), TypeError);
    assert.throws(() => userVersionState(true, 0), TypeError);
    assert.throws(() => userVersionState(1, null), TypeError);
    assert.throws(() => userVersionState(1.5, 0), TypeError);
});

await ok('EXEC_LANGUAGES：12 个，不重复，与任务书清单逐位一致', () => {
    const want = ['javascript', 'typescript', 'python', 'shell', 'ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp'];
    assert.deepEqual([...EXEC_LANGUAGES], want);
    assert.equal(new Set(EXEC_LANGUAGES).size, 12);
});

await ok('SCRIPT_EXT：键 = 12 语言，值非空且互不冲突（r→R 大小写敏感照原样）', () => {
    assert.deepEqual(Object.keys(SCRIPT_EXT).sort(), [...EXEC_LANGUAGES].sort());
    assert.equal(SCRIPT_EXT.r, 'R');
    assert.equal(SCRIPT_EXT.shell, 'sh');
    assert.equal(SCRIPT_EXT.csharp, 'csx');
    assert.equal(SCRIPT_EXT.elixir, 'exs');
});

await ok('DEFAULTS：每个值都是有限正数，且八条键齐全（道 A 的 HINT_MAX_BYTES 已退役）', () => {
    // ★ 2026-11-14（项目 07）：`HINT_MAX_BYTES` 随道 A 摘除（说明：「把道A去掉」）。
    //   这里**必须**从"应存在的键"清单里删掉 —— 否则本断言会红，
    //   而有人为了让它绿会把常量加回去，等于悄悄复活道 A 的一个零件。
    const want = ['MAX_CHUNK_BYTES', 'OPTIMIZE_EVERY', 'RETENTION_DAYS', 'MEMORY_MAX_BYTES', 'RECAP_MAX_BYTES', 'RRF_K', 'SEARCH_P95_MS', 'TOOL_TIMEOUT_MS'];
    assert.deepEqual(Object.keys(DEFAULTS).sort(), want.sort());
    for (const [k, v] of Object.entries(DEFAULTS)) {
        assert.equal(typeof v, 'number', `${k} 必须是 number，实际 ${typeof v}`);
        assert.ok(Number.isFinite(v) && v > 0, `${k} 必须是有限正数，实际 ${v}`);
    }
    assert.equal(DEFAULTS.MEMORY_MAX_BYTES, 65536);
    assert.equal(DEFAULTS.RRF_K, 60);
    assert.equal(DEFAULTS.HINT_MAX_BYTES, undefined, 'HINT_MAX_BYTES 又回来了 —— 道 A 的零件被复活');
});

await ok('DEFAULTS 冻结（下游改不动）', () => {
    assert.throws(() => {
        DEFAULTS.RRF_K = 1;
    }, TypeError);
});

await ok('init(ctx) 把 defaults / languages 挂进 ctx', async () => {
    const ctx = {};
    const r = await init(ctx);
    assert.equal(r.name, 'core');
    assert.equal(ctx.defaults, DEFAULTS);
    assert.equal(ctx.languages, EXEC_LANGUAGES);
});

console.log(`[selftest] ${NAME} — ${n} 条断言全绿 ✅`);
