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
 * libs/log.js — 四级日志（D5 的唯一实现）
 *
 * 干什么：引擎里所有块都通过这一个 logger 打日志，不各自 console.log。
 * 为什么这样：① 四级可关（error/warn/info/debug），宿主里默认 info，selftest 里 debug；
 *            ② 同一件事不重复打 —— 用 dedupeKey 做进程内去重（比如"库已打开"每轮都会发生）；
 *            ③ 输出格式固定 `[level][块名] 消息`，日志能被 grep 到块级来源。
 * 边界：这里不写文件、不收集指标（指标归 09-reader/12-lifecycle 的 stats），只是通道。
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * @param {object} [opts]
 * @param {'error'|'warn'|'info'|'debug'} [opts.level] 默认 info；env ENGINE_LOG 可覆盖
 * @param {(rec:{level:string,scope:string,msg:string,at:number})=>void} [opts.sink] 默认写 stderr
 */
export function createLogger(opts = {}) {
    const level = LEVELS[opts.level ?? process.env.ENGINE_LOG ?? 'info'] ?? LEVELS.info;
    const sink = opts.sink ?? ((rec) => {
        // 只写 stderr：stdout 归工具返回值（宿主/CLI 都靠 stdout 读结果）
        console.error(`[${rec.level}][${rec.scope}] ${rec.msg}`);
    });
    /** 去重表：key → 上次打印时间。窗口内同一 key 不再打（计数攒着，窗口外打一次总量）。 */
    const seen = new Map();
    const WINDOW_MS = 60_000;

    function emit(lv, scope, msg, dedupeKey) {
        if (LEVELS[lv] > level) return;
        if (dedupeKey) {
            const now = Date.now();
            const prev = seen.get(dedupeKey);
            if (prev && now - prev.at < WINDOW_MS) {
                prev.count++;
                return; // 窗口内重复，静默
            }
            const count = prev ? prev.count + 1 : 1;
            seen.set(dedupeKey, { at: now, count: 1 });
            if (count > 1) msg = `${msg}（上次窗口内另发生 ${count - 1} 次，已合并）`;
        }
        sink({ level: lv, scope, msg: String(msg), at: Date.now() });
    }

    /** 取一个绑定了块名的 logger：块内只写 l.info('…') */
    const forScope = (scope) => ({
        error: (m, k) => emit('error', scope, m, k),
        warn: (m, k) => emit('warn', scope, m, k),
        info: (m, k) => emit('info', scope, m, k),
        debug: (m, k) => emit('debug', scope, m, k),
        /** 计时代段：l.span('打开库', fn) 超 50ms 才打 */
        span(label, fn) {
            const t0 = performance.now();
            try {
                return fn();
            } finally {
                const ms = performance.now() - t0;
                if (ms >= 50) emit('debug', scope, `${label} 耗时 ${ms.toFixed(1)}ms`);
            }
        },
    });

    return { forScope, level: opts.level ?? process.env.ENGINE_LOG ?? 'info', _emit: emit };
}

/** selftest 用的内存 sink：收集日志行，供断言。 */
export function memorySink() {
    const lines = [];
    return {
        lines,
        sink: (rec) => lines.push(rec),
        has: (re) => lines.some((r) => re.test(`[${r.level}][${r.scope}] ${r.msg}`)),
    };
}
