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
 * 13-sandbox/script-file.js — 把一段代码落成临时脚本文件
 *
 * 干什么：按语言做「必要的包装」（go 要 main 包、php 要开标签、shell 要修 mvn、
 *        PowerShell 要 BOM + 编码前导），写到沙箱临时目录，返回绝对路径。
 * 为什么这样：移植自 `engine/ref/current-engine/executor.js` 的 `#writeScript`（只读基线）。
 *            这些包装不是装饰 —— 少了任何一条，对应语言要么语法错要么输出被编码毁掉。
 * 边界：只写文件、只做字符串变换；不 spawn、不连库。
 */

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildScriptFilename } from './runtime-probe.js';

function quoteForPosixShell(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 前导：BOM + 控制台编码设成 UTF-8（5.1 不设就会按 ANSI 读，非 ASCII 全毁）。 */
export function buildPowerShellScriptContent(code) {
    return [
        '\uFEFF[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
        '$OutputEncoding = [System.Text.UTF8Encoding]::new()',
        code,
    ].join('\n');
}

/** POSIX shell：把父 PATH 显式写回头几行（shell 启动文件会重置 PATH）。 */
export function buildShellScriptContent(code, inheritedPath, platform) {
    if (platform === 'win32' || !inheritedPath) return code;
    return `export PATH=${quoteForPosixShell(inheritedPath)}\n${code}`;
}

/**
 * #782：Windows 上裸 `mvn` 走 Maven 的 POSIX 脚本，mingw 分支把 CLASSWORLDS_JAR
 * 留在 POSIX 路径上，原生 java.exe 打不开 → ClassNotFoundException。
 * 只把「处于命令开头位置」的裸 `mvn` 改成 `mvn.cmd`；`mvnw`/`mvnd`/`./mvnw`/`mvn.cmd` 一律不动。
 * 算法式（不写正则）：只在字符串开头或 shell 分隔符之后、跳过前导空白，且 token 恰好是 `mvn` + 空白/结尾。
 */
export function rewriteWindowsBuildTools(code, platform) {
    if (platform !== 'win32') return code;
    const SEP = new Set([';', '&', '|', '(', '\n']);
    let out = '';
    let atStart = true;
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (atStart && (ch === ' ' || ch === '\t')) { out += ch; i++; continue; }
        if (atStart && code.startsWith('mvn', i)) {
            const after = code[i + 3];
            if (after === undefined || after === ' ' || after === '\t' || after === '\n') {
                out += 'mvn.cmd';
                i += 3;
                atStart = false;
                continue;
            }
        }
        out += ch;
        atStart = SEP.has(ch);
        i++;
    }
    return out;
}

function isPowerShell(shellPath) {
    const name = String(shellPath ?? '').toLowerCase();
    return name.includes('powershell') || name.includes('pwsh');
}

/**
 * 写脚本文件。
 * @param {string} tmpDir 沙箱临时目录（调用方负责建与删）
 * @param {string} code 脚本正文
 * @param {string} language
 * @param {object} opts `{ runtimes, platform?, projectRoot?, inheritedPath? }`
 * @returns {string} 脚本绝对路径
 */
export function writeScript(tmpDir, code, language, opts = {}) {
    const platform = opts.platform ?? process.platform;
    const runtimes = opts.runtimes ?? {};
    const projectRoot = opts.projectRoot ?? process.cwd();
    let body = code;

    // Go：没有 package 声明就包一层 main
    if (language === 'go' && !body.includes('package ')) {
        body = `package main\n\nimport "fmt"\n\nfunc main() {\n${body}\n}\n`;
    }
    // PHP：没有开标签就补
    if (language === 'php' && !body.trimStart().startsWith('<?')) {
        body = `<?php\n${body}`;
    }
    // Elixir：在 Mix 项目里要把编译产物路径加进 Code.prepend_path
    if (language === 'elixir' && existsSync(join(projectRoot, 'mix.exs'))) {
        const escaped = JSON.stringify(join(projectRoot, '_build/dev/lib'));
        body = `Path.wildcard(Path.join(${escaped}, "*/ebin"))\n|> Enum.each(&Code.prepend_path/1)\n\n${body}`;
    }

    const shellPath = language === 'shell' ? runtimes.shell?.path ?? null : null;
    const filename = buildScriptFilename(language, platform, shellPath);
    const filePath = join(tmpDir, filename);

    if (language === 'shell') {
        const rewritten = rewriteWindowsBuildTools(body, platform);
        const shellCode = platform === 'win32' && isPowerShell(shellPath)
            ? buildPowerShellScriptContent(rewritten)
            : rewritten;
        writeFileSync(filePath, buildShellScriptContent(shellCode, opts.inheritedPath ?? process.env.PATH, platform), {
            encoding: 'utf8',
            mode: 0o700,
        });
    }
    else {
        writeFileSync(filePath, body, 'utf8');
    }
    return filePath;
}
