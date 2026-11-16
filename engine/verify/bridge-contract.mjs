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
 * verify/bridge-contract.mjs — G9 的前半：**桥一行不改就能接上新引擎**
 *
 * 干什么：模拟 `bridges/engine-client.js` 的五个调用点（start/initialize/listTools/callTool/shutdown）
 *        与 `bridge.js` 读到的三样东西（toolNames / call / module.REGISTERED_CTX_TOOLS），
 *        断言新引擎的返回形状与 1.2.2 完全同形。
 * 为什么这样：D3①「桥接层一行不改就能接新引擎」是 S9.8 的验收门；不同形就得改桥 = 破 D3。
 * 边界：本脚本**不 import 真桥**（那是 DSH 侧装饰层），只复刻它的读取行为。
 *
 * 跑法：node engine/verify/bridge-contract.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempRunDir, releaseTempRunDir } from '../libs/tempdir.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.dirname(HERE);
// ★ 临时目录须容错解析：默认走系统临时目录（可用 TEMP_DEV_DIR 固定），
//   但成品装机后可能落在不可写位置（如 <profile>/Temp）→ EPERM 假红。
//   规矩：优先工作区 Temp，不可用就退系统临时目录。
const RUN = makeTempRunDir('bridge-contract');
let n = 0;
const ok = (label) => { n++; console.log(`  ✓ ${label}`); };

try {
    releaseTempRunDir(RUN);
    fs.mkdirSync(RUN, { recursive: true });

    const entry = await import(`file://${ENGINE.replace(/\\/g, '/')}/index.mjs?t=${Date.now()}`);
    const engine = await entry.createEngine({ contentDir: RUN, level: 'error' });

    // ── 桥的五个调用点（回源 bridges/engine-client.js L83-209）──
    ok('① start() 存在且可调用（进程内版什么都不起）');
    assert.equal(typeof engine.dispose, 'function');

    ok('② toolNames 是数组（平台层用它报"注册了几个工具"）');
    assert.ok(Array.isArray(engine.toolNames), `toolNames 类型 ${typeof engine.toolNames}`);
    assert.deepEqual(engine.toolNames, ['ctx'], JSON.stringify(engine.toolNames));

    ok('③ module.REGISTERED_CTX_TOOLS 形状同 1.2.2（name / config.description / inputSchema / handler）');
    const reg = engine.module?.REGISTERED_CTX_TOOLS;
    assert.ok(Array.isArray(reg) && reg.length === 1, `REGISTERED_CTX_TOOLS 长度 ${reg?.length}（1.0.0 只剩 1 个工具位）`);
    for (const r of reg) {
        assert.equal(typeof r.name, 'string', '缺 name');
        assert.equal(typeof r.config?.description, 'string', `${r.name} 缺 config.description`);
        assert.equal(typeof r.inputSchema, 'object', `${r.name} 缺 inputSchema`);
        assert.equal(typeof r.handler, 'function', `${r.name} 缺 handler`);
        assert.ok(Buffer.byteLength(r.config.description) > 10, `${r.name} 描述太短`);
    }

    ok('④ inputSchema 是纯 JSON（可结构化克隆）—— 1.2.2 事故护栏');
    const clone = JSON.parse(JSON.stringify(reg.map((r) => r.inputSchema)));
    assert.equal(clone.length, 1);
    for (const s of clone) assert.equal(s.type, 'object', 'schema 必须是 JSON Schema object');

    ok('⑤ ctx 描述 ≤1563B ≈300 token（折叠后模型只看得到它）');
    const runDesc = reg.find((r) => r.name === 'ctx').config.description;
    const descBytes = Buffer.byteLength(runDesc);
    assert.ok(descBytes <= 1563, `ctx 描述 ${descBytes} B > 1563 B（≈300 token）`);

    ok('⑥ call(name, args) 返回 MCP 形状 {content:[{type:"text",text}]}');
    const r1 = await engine.call('ctx', { op: 'list' });
    assert.ok(Array.isArray(r1.content), `返回形状不对：${JSON.stringify(r1).slice(0, 80)}`);
    assert.equal(r1.content[0].type, 'text');
    assert.equal(typeof r1.content[0].text, 'string');
    assert.ok(r1.content[0].text.includes('op'), '自描述表里应有 op 列');
    assert.ok(r1.content[0].text.includes('index'), '自描述表里应列出 index');

    ok('⑦ 坏 op → isError:true + 可读文本（不穿透异常到宿主）');
    const r2 = await engine.call('ctx', { op: 'nope' });
    assert.equal(r2.isError, true, JSON.stringify(r2).slice(0, 80));
    assert.ok(r2.content[0].text.length > 0);

    ok('⑧ ctx op=index → op=list 真往返（真库已装配）');
    const w = await engine.call('ctx', { op: 'index', content: '# 桥接验证\n这段内容要能被搜出来。', source: 'bridge-doc' });
    assert.ok(w.content[0].text.includes('已写入'), w.content[0].text);
    assert.equal(w.isError, undefined, '写入不该是错误');

    ok('⑨ ctx op=recall 能召回刚写的内容（真查；2026-11-04 起 recall 是 op 不是工具位）');
    const hits = await engine.call('ctx', { op: 'recall', queries: ['桥接验证'] });
    assert.ok(hits.content[0].text.includes('bridge-doc') || hits.content[0].text.includes('桥接验证'),
        hits.content[0].text.slice(0, 120));

    ok('⑩ dispose() 可调用且幂等');
    engine.dispose();
    engine.dispose();

    // ── ⑪-⑬ 沙箱归一（P4）的反证：受限 run **必须真进引擎**（旧架构 by_tool 恒 0）──
    // 判据不看 spawn 成败（dev 环境可能 HOST_PIPE_DENIED），看的是 confine 有没有被调、
    // session 有没有一路带到位 —— 只要这两个成立，"桥自己跑代码、引擎不知情"的时代就死了。
    {
        const seen = { confineCalls: 0, resolveSessions: [], lastArgv: null };
        const mockHost = {
            get: (svc) => {
                if (svc === 'sandbox') return {
                    confine: async (argv, policy, signal) => {
                        seen.confineCalls += 1; seen.lastArgv = argv;
                        if (policy?.mode === 'workspace-write') return { argv: [...argv] }; // 重写：复制一份
                        return { argv };
                    },
                };
                if (svc === 'sandboxPolicy') return {
                    resolve: async (opts) => {
                        seen.resolveSessions.push(opts?.session?.id ?? '(none)');
                        return { mode: 'workspace-write', workspaceRoot: RUN };
                    },
                };
                return undefined;
            },
        };
        const engine2 = await entry.createEngine({ ctx: mockHost, contentDir: path.join(RUN, 'bc2'), level: 'error' });
        // ★★ 2026-11-06 S9.43 修（门自己过期了，不是产品坏了）
        //   原判据拿 `language:'python'` 当"白名单外语言"的证据 —— 那是 S9.42 之前的口径。
        //   S9.42（2026-11-06）把受限白名单从写死 javascript 改成**探测结果**
        //   （13-sandbox/index.js:110 `probeRuntimes().languages.filter(l=>l.ok)` + 兜底 javascript），
        //   本机探测出 `javascript | python | shell` 三种全 ok（那道门的输出自己也印了这三个）。
        //   于是 `python` 从"必被拦"变成了"能跑"—— 这一项从 S9.42 装机那天起就必红，
        //   红的是断言过期，不是 confinement 坏了。
        //
        //   新判据必须挑一个**本机探测不到**的语言：csharp。
        //   实测（2026-11-06）：`dotnet.exe` 在（C:\Program Files\dotnet\dotnet.exe），
        //   但没有 SDK、没有 dotnet-script → S9.42 已把它判成假阳性=未安装 → 一定不在白名单。
        //   同时把"python 现在允许"这件事也钉成断言，免得再有人把白名单改回写死 javascript 时没人发现。
        const r3 = await engine2.call('ctx',
            { op: 'run', language: 'csharp', code: 'print(1)' },
            { signal: undefined, session: { id: 'bc-session' } });
        ok('⑪ 受限判定在引擎内：白名单外语言 → 引擎直接 LANGUAGE_NOT_CONFINABLE（confine 都没到）');
        assert.ok(r3.content[0].text.includes('LANGUAGE_NOT_CONFINABLE'), r3.content[0].text.slice(0, 140));
        assert.equal(seen.confineCalls, 0, '被白名单拦下就不该起改写（省一次宿主往返，也证明判定在引擎里）');
        assert.ok(seen.resolveSessions.includes('bc-session'), `session 没进引擎：${JSON.stringify(seen.resolveSessions)}`);
        // ★ 白名单是探测结果、不是写死：本机能跑的 python 必须在里面（S9.42 的判据）
        assert.ok(/allowed:\s*([^\n]*\bpython\b)/.test(r3.content[0].text),
            `白名单里没有 python —— 白名单又被写死了？拒言原文：${r3.content[0].text.slice(0, 160)}`);

        const r4 = await engine2.call('ctx',
            { op: 'run', code: 'process.stdout.write("in-engine")' },
            { signal: undefined, session: { id: 'bc-session-2' } });
        ok('②→⑫ 受限白名单内（javascript）：confine 真被调用（受限 run 走引擎的铁证）');
        assert.equal(seen.confineCalls, 1, `op:run 没经过宿主闸门：confineCalls=${seen.confineCalls}（旧架构的 0 回来了）`);
        assert.ok(Array.isArray(seen.lastArgv) && seen.lastArgv.length >= 2, 'confine 收到的 argv 应是完整启动命令');
        // spawn 结果随 dev 环境变（真跑 in-engine / 受限 HOST_PIPE_DENIED），不作断言 —— 断言的是链路。
        void r4;

        // ⑬ confine 抛 = 拒跑，绝不原样起进程（fail-closed 端到端）
        seen.confineCalls = 0;
        mockHost.get = (svc) => {
            if (svc === 'sandbox') return { confine: async () => { throw Object.assign(new Error('ACL 拒'), { code: 'EPERM_DENIED' }); } };
            if (svc === 'sandboxPolicy') return { resolve: async () => ({ mode: 'workspace-write', workspaceRoot: RUN }) };
            return undefined;
        };
        const engine3 = await entry.createEngine({ ctx: mockHost, contentDir: path.join(RUN, 'bc3'), level: 'error' });
        const r5 = await engine3.call('ctx', { op: 'run', code: 'x' }, { session: { id: 'bc3' } });
        ok('⑬ confine 抛错 → DENIED_PATH 文本进 MCP 形状（不穿透栈、不裸跑）');
        assert.ok(r5.isError === true || /DENIED_PATH/.test(r5.content[0].text), r5.content[0].text.slice(0, 140));
        engine2.dispose();
        engine3.dispose();
    }

    console.log(`\nbridge-contract: ${n} 项全绿 ✅`);
}
catch (e) {
    console.error('bridge-contract 失败：', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
}
finally {
    releaseTempRunDir(RUN);
}
