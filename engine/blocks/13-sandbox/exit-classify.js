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
 * 13-sandbox/exit-classify.js — 退出码分类
 *
 * 干什么：把「子进程非零退出」分成「真失败」与「shell 软失败」两种，
 *        后者只回 stdout（模型要看的是输出，不是错误文案）。
 * 为什么这样：移植自 `engine/ref/current-engine/exit-classify.js`（13 行，只读基线）。
 * 边界：纯函数。
 */

/**
 * @param {{language:string, exitCode:number, stdout:string, stderr:string}} params
 * @returns {{isError:boolean, output:string}}
 */
export function classifyNonZeroExit(params) {
    const { language, exitCode, stdout, stderr } = params;
    const isSoftFail = language === "shell" &&
        exitCode === 1 &&
        stdout.trim().length > 0;
    return {
        isError: !isSoftFail,
        output: isSoftFail
            ? stdout
            : `Exit code: ${exitCode}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
    };
}
