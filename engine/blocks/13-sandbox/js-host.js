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
 * 13-sandbox/js-host.js — javascript 的双宿主（P3 从桥侧 guard 下沉）
 *
 * 干什么：决定一段 javascript 怎么落盘才能跑：
 *   · 顶层 `import` 的正经 ESM → 直接 `.mjs` 起；
 *   · 其余（`require` + 顶层 await 的 CommonJS 味代码）→ 写 entry.mjs
 *     宿主：createRequire 供 require、async-IIFE 供顶层 await，两者同时可用。
 * 为什么这样：装配根 package.json 是 `type:module`，`.js` 会被 node 按 ESM 解析 ——
 *   带 `require` 的代码直接崩 "require is not defined in ES module scope"。
 *   guard 实测过（1.0.3），这条宿主就是它的全部沙箱秘密，现在归引擎。
 * 边界：只写文件、只给 argv 尾巴；不起进程。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 宿主源码（与 guard 的 ENTRY_SOURCE 同语义，路径参数化）。 */
const ENTRY_SOURCE = `import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [scriptPath, cwdPath] = process.argv.slice(2);
if (typeof cwdPath === 'string' && cwdPath.length > 0)
    process.chdir(cwdPath);
const module = { exports: {} };
const require = createRequire(scriptPath);
const source = readFileSync(scriptPath, 'utf8');
const invoke = new Function('require', 'module', 'exports', '__dirname', '__filename', 'return (async () => {\\n' + source + '\\n})();');
const result = await invoke(require, module, module.exports, cwdPath ?? process.cwd(), scriptPath);
if (result !== undefined) {
    try {
        console.log(typeof result === 'string' ? result : JSON.stringify(result));
    }
    catch {
        console.log(String(result));
    }
}
`;

/**
 * 是否顶层 import（正经 ESM）。行首（允许缩进）的 `import` 且不是 `import(` 动态调用。
 * @param {string} code
 */
export function usesEsmImport(code) {
    return /^[ \t]*import[ \t]+[^(]/m.test(code);
}

/**
 * javascript 的落盘 + argv 尾巴。
 * @param {string} tmpDir 沙箱临时目录（调用方建/删）
 * @param {string} code 脚本正文
 * @param {string} workdir 子进程 cwd（宿主 chdir 用，保持相对路径语义与父一致）
 * @param {string} nodePath node/bun 可执行路径（argv[0] 由调用方拼好，这里给后续参数）
 * @param {boolean} isBun bun 要 `run` 子命令
 * @returns {{ rest: string[], esm: boolean }} rest = 跟在运行时后面的 argv
 */
export function writeJsHost(tmpDir, code, workdir, nodePath, isBun) {
    if (usesEsmImport(code)) {
        const scriptPath = join(tmpDir, 'script.mjs');
        writeFileSync(scriptPath, code, 'utf8');
        return { rest: isBun ? ['run', scriptPath] : [scriptPath], esm: true };
    }
    const scriptPath = join(tmpDir, 'payload.js');
    writeFileSync(scriptPath, code, 'utf8');
    const entryPath = join(tmpDir, 'entry.mjs');
    writeFileSync(entryPath, ENTRY_SOURCE, 'utf8');
    return { rest: isBun ? ['run', entryPath, scriptPath, workdir] : [entryPath, scriptPath, workdir], esm: false };
}
