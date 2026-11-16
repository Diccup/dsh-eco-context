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
 * 06-gram — 中文 gram 通道（库的中文命门）
 *
 * 干什么：把汉字串变成「单字 + 相邻双字」的 gram 列文本（写入侧），
 *        并把查询拆成「词通道 + gram 通道」两半（查询侧）。
 * 为什么这样：实测三口径 79/15/66 → 98/85/96（01-立项书 §六 裁决①），写放大只 +3.7%。
 *         单字必须和双字同列：只存双字时单字查询「僵」从 39 命中掉到 0。
 * 边界：只做文本变换与表达式拼装，不碰库、不碰文件。移植自 engine/ref/lib/gram-channel.mjs（187 行）。
 *
 * 两条铁律（血泪来的，不许改）：
 *   ① 索引侧必须折叠汉字之间的任意水平空白（"僵 尸" 真库里有 802,169 处单空格 + 15,846 处三空格）。
 *   ② 查询侧**绝不折叠空白**：用户空格是词边界语义，折了会生成跨词假双字「尸进」。
 */

export const NAME = 'gram';
export const INVARIANTS = [
    '索引侧折叠水平空白，查询侧绝不折叠',
    '单字与双字在同一 gram 列，run 之间用 bm_script_boundary 隔开防跨 run 假双字',
    '查询含引号或显式 AND/OR/NOT 时整串交回词解析器，保住布尔语义',
];

export const SCRIPT_BOUNDARY = 'bm_script_boundary';

/** BM 的 _SCRIPT_SEARCH_RANGES：书写时不用可靠词边界的文字，全部沿用参考实现别缩。 */
export const SCRIPT_RANGES = [
    [0x1100, 0x11ff], [0x0e00, 0x0eff], [0x0f00, 0x0fff], [0x1000, 0x109f],
    [0x1780, 0x17ff], [0x19e0, 0x19ff], [0x3005, 0x3007], [0x3021, 0x3029],
    [0x3031, 0x3035], [0x3038, 0x303b], [0x3040, 0x30ff], [0x3100, 0x318f],
    [0x31a0, 0x31bf], [0x31f0, 0x31ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
    [0xa960, 0xa97f], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f], [0xac00, 0xd7af],
    [0xd7b0, 0xd7ff], [0xf900, 0xfaff], [0x1aff0, 0x1afff], [0x1b000, 0x1b16f],
    [0x20000, 0x2ffff], [0x30000, 0x323af],
];

const JOIN_CONTROLS = new Set([0x200c, 0x200d]); // ZWNJ / ZWJ

export function isScriptChar(ch) {
    const n = ch.codePointAt(0);
    for (const [lo, hi] of SCRIPT_RANGES) if (n >= lo && n <= hi) return true;
    return false;
}

/** 补丁：折叠汉字之间的【任意水平空白】。不折 \r\n（保留行结构）。 */
export function deSpaceHan(text) {
    if (!text) return text;
    return text.replace(/(\p{Script=Han})[^\S\r\n]+(?=\p{Script=Han})/gu, '$1');
}

/** 切出可搜索的 script run：ASCII 不是成员；组合符黏附前一单元；ZWJ/ZWNJ 不断 run。 */
export function scriptRuns(text) {
    if (!text) return [];
    const cps = [...text.normalize('NFKC')];
    const runs = [];
    let cur = null;
    for (const ch of cps) {
        if (isScriptChar(ch)) {
            if (!cur) cur = [];
            cur.push(ch);
        }
        else if (cur && /\p{M}/u.test(ch)) {
            cur[cur.length - 1] += ch;
        }
        else if (cur && JOIN_CONTROLS.has(ch.codePointAt(0))) {
            // 保持 run 连续，不加单元
        }
        else if (cur) {
            runs.push(cur);
            cur = null;
        }
    }
    if (cur) runs.push(cur);
    return runs;
}

/** 单字 run 原样保留；多字 run 产出全部相邻双字。 */
export function runGrams(run) {
    if (run.length === 1) return run;
    const out = [];
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run[i] + run[i + 1]);
    return out;
}

/** 建索引文本（写进 script_ngrams 列）。 */
export function buildScriptNgrams(...texts) {
    const groups = [];
    for (const raw of texts) {
        if (!raw) continue;
        const folded = deSpaceHan(raw);
        const seen = new Set();
        for (const run of scriptRuns(folded)) {
            const terms = run.length === 1 ? run : [...run, ...runGrams(run)];
            const key = terms.join(' ');
            if (seen.has(key)) continue;
            seen.add(key);
            groups.push(key);
        }
    }
    return groups.join(` ${SCRIPT_BOUNDARY} `);
}

/**
 * 拆分查询：词通道 + gram 通道。
 * 含引号或显式 AND/OR/NOT 时整串交回原后端解析器，保住布尔语义。
 * 含任一「非 script 的字母数字」的 token 走词通道；纯 script 的 token 才进 gram。
 *
 * ★ 混排 token（"僵尸WAL"）必须**拆开**：CJK 段进 gram，ASCII 段进词通道。
 *   原实现把整串塞进词通道，导致 `"僵尸进程会持有WAL锁…"` 这种超长短语在
 *   porter 表里永远匹配不到（2026-11-03 T-2 实测 0/3）。
 */
export function analyzeScriptQuery(text) {
    if (!text) return { word_text: null, gram_phrases: [] };
    const padded = ` ${text} `;
    if (text.includes('"') || [' AND ', ' OR ', ' NOT '].some((op) => padded.includes(op))) {
        return { word_text: text, gram_phrases: [] };
    }
    const wordTokens = [];
    const gramPhrases = [];
    let mixedAdjacent = false;
    for (const token of text.split(/\s+/)) {
        if (!token) continue;
        const normalized = token.normalize('NFKC');
        // ★ 混排检测：同一 token 内既有 CJK 又有 ASCII 字母数字且紧邻 →
        //   在 porter 表里它们会被 unicode61 粘成一个 token（如「僵尸wal判定」），
        //   单独搜 "WAL" 必然 0 命中（2026-11-03 T-2 第 3 条实测）。
        //   这种 token 的 ASCII 段不交 porter，交给 trigram 榜（子串可搜）。
        {
            const chars = [...normalized];
            for (let i = 0; i + 1 < chars.length; i++) {
                const a = chars[i], b = chars[i + 1];
                const aScript = isScriptChar(a), bScript = isScriptChar(b);
                const aWord = /[\p{L}\p{N}]/u.test(a) && !aScript;
                const bWord = /[\p{L}\p{N}]/u.test(b) && !bScript;
                if ((aScript && bWord) || (aWord && bScript)) { mixedAdjacent = true; break; }
            }
        }
        // ① gram：整 token 的所有 script run（CJK 段）
        for (const run of scriptRuns(deSpaceHan(normalized))) {
            const grams = runGrams(run);
            if (grams.length) gramPhrases.push(grams);
        }
        // ② 词通道：只取「非 script 的字母数字段」，不把 CJK 一起塞进去
        const wordChars = [...normalized].map((ch) => (/[\p{L}\p{N}]/u.test(ch) && !isScriptChar(ch) ? ch : ' ')).join('');
        for (const w of wordChars.split(/\s+/).filter(Boolean)) {
            const upper = w.toUpperCase();
            wordTokens.push(['AND', 'OR', 'NOT'].includes(upper) ? w.toLowerCase() : w);
        }
    }
    const wordText = wordTokens.join(' ') || (gramPhrases.length ? null : text);
    return { word_text: wordText, gram_phrases: gramPhrases, mixed_adjacent: mixedAdjacent };
}

/**
 * 拼 gram 通道 MATCH 表达式。
 *
 * ★ 长 run 必须切成**滑动窗口**再 OR（2026-11-03 T-2 的根因）：
 *   把 20 字中文压成一个短语 `"僵尸 尸进 进程 …"` 时，只要文档在中间有
 *   标点/空白/英文（run 边界），短语就断掉 → 命中 0。这正是 `ours/cjk.js`
 *   8 字上限那个 bug 的同族问题：**长查询不能要求整串连续**。
 *   短 run（≤maxWindow 个双字）仍走整短语，保住精度。
 */
/**
 * 拼 gram 通道 MATCH 表达式。
 *
 * ★ 三条实测教训（2026-11-03 T-2 连撞三下，都记在这里，别再改回去）：
 *   ① 不能把长 run 压成一个整短语：文档侧只要有一处标点/空格/英文，run 就断 → 命中 0。
 *      （这就是 `ours/cjk.js` 的 8 字上限同族病。）
 *   ② 也不能逐对全 OR 就把整串都放宽：查询跨 run 时，跨断点的对**在列里根本不存在**
 *      （buildScriptNgrams 用 bm_script_boundary 隔开 run，防跨 run 假双字）。
 *   ③ 正解 = **窗口大小自适应**：短查询（≤4 双字）整短语保精度；
 *      长查询按 3 双字窗口滑（重叠 1），窗口 OR —— 窗口内一定在同一个 run 里，
 *      不会跨断点；且只要文档里有连续 4 个汉字相同片段就能命中。
 *      精度交给 09-reader 的 RRF + proximity（它按紧邻窗口重排）。
 */
export function gramMatchExpr(gramPhrases, column = 'script_ngrams', opts = {}) {
    const shortLen = opts.shortLen ?? 4;    // ≤4 个双字：整短语
    const winLen = opts.winLen ?? 3;        // 长 run：3 个双字（=4 个汉字连续）
    const usable = gramPhrases.filter((p) => p && p.length);
    if (!usable.length) return null;

    const groupExprs = usable.map((p) => {
        if (p.length <= shortLen) return `"${p.join(' ')}"`;
        const wins = [];
        for (let i = 0; i + winLen <= p.length; i++) {
            const w = p.slice(i, i + winLen);
            // 跳过跨断点的窗口（run 内不会有边界哨兵，但防御性检查一遍）
            if (w.some((x) => x.includes(SCRIPT_BOUNDARY))) continue;
            wins.push(`"${w.join(' ')}"`);
        }
        // 末尾补一个收尾窗口（保证最后几个字也被覆盖）
        const tail = p.slice(-winLen);
        const tailStr = `"${tail.join(' ')}"`;
        if (!wins.includes(tailStr)) wins.push(tailStr);
        return wins.length === 1 ? wins[0] : `(${wins.join(' OR ')})`;
    });
    // 多个独立 run（查询里被非 script 字符隔开）之间 AND：两段都要出现
    return `${column}: (${groupExprs.join(' AND ')})`;
}

/**
 * ★ 只出 **gram 列** 的 MATCH 表达式（不要词通道）。
 *
 * 为什么必须单独出这一条（2026-11-04 三榜重写时抓到的根）：
 *   `buildMatch` 返回的是「词条件 AND gram 条件」**混成一条**表达式，
 *   拿它去查 `chunks` 表 = 词通道和 gram 通道同时生效 = **一层顶两层**。
 *   09-reader 曾把它当 porter 榜用，于是「porter 榜」和「gram 榜」跑的是同一条
 *   表达式、同一张表 → RRF 融合的是**同一张榜两次**（三榜塌成一榜）。
 *
 * 本函数只吐 `script_ngrams: (...)` 一段 → 打的就是那一列 → **层间真独立**。
 *
 * ★★ 混合式（`mixWithWords`，默认开）—— P-01 实测逼出来的写法：
 *   纯列过滤 `script_ngrams:(...)` 有两个结构性问题：
 *     ① **bm25 三列权重全部失效**（实测得分恒 0.000）：FTS5 的 bm25 只对
 *        **实际参与匹配的列**计分；列过滤时只有 script_ngrams 匹配，title/content
 *        没匹配 → 三个权重都不起作用 → **gram 列权重根本不可调**（P-01 的问法失效）。
 *     ② **gram 榜内部没有区分度**：所有命中得分相同 → 排序全靠 rowid。
 *   解法：把**同词的 title/content 条件 OR 进来**：
 *        (script_ngrams:(...) OR title:(...) OR content:(...))
 *   实测（真库）：**召回数完全不变**（1943 = 1943），但 bm25 有真实梯度
 *   （-12.4684 / -12.4615 / -12.2982 …），权重从此可调、排序有区分度。
 *   ★ 用 **OR 不是 AND** —— AND 会收窄结果集（那是 `buildMatch` 的旧行为，也是"一层顶两层"的根）。
 *
 * @param {string} q 查询串
 * @param {{column?:string, ignoreBoolean?:boolean, mixWithWords?:boolean}} [opts]
 *   `ignoreBoolean: true` 时忽略引号/AND/OR/NOT 的整串直通规则，
 *   仍把 CJK 段抽成 gram（原生布尔查询里的中文段由这一层兜底）。
 *   `mixWithWords: false` 时退回纯列过滤（诊断用；P-01 对拍时用）。
 * @returns {string|null} 表达式；查询里没有 CJK 时返回 null（该层不出榜）
 */
export function gramOnlyExpr(q, { column = 'script_ngrams', ignoreBoolean = false, mixWithWords = true } = {}) {
    if (!q) return null;
    let phrases;
    let words = [];
    if (ignoreBoolean) {
        // 原生布尔查询：去掉引号与布尔运算符，只留 CJK 段 → gram 通道兜底中文
        const stripped = String(q).replace(/["']/g, ' ').replace(/\b(AND|OR|NOT|NEAR)\b/g, ' ');
        phrases = [];
        words = stripped.split(/\s+/).filter((w) => w.length > 0);
        for (const run of scriptRuns(deSpaceHan(stripped))) {
            const grams = runGrams(run);
            if (grams.length) phrases.push(grams);
        }
    }
    else {
        ({ gram_phrases: phrases } = analyzeScriptQuery(String(q)));
        words = String(q).split(/\s+/).filter((w) => w.length > 0);
    }
    const gramPart = gramMatchExpr(phrases ?? [], column);
    if (!gramPart) return null;
    if (!mixWithWords) return gramPart;

    // 混合式：gram 列 OR 同词的 title/content（**OR 不是 AND** → 不收窄结果集）
    const wordPart = words
        .filter((w) => /[\p{L}\p{N}]/u.test(w))
        .map((w) => `"${w.replace(/"/g, '""')}"`);
    if (!wordPart.length) return gramPart;
    const wordsOr = `(${wordPart.join(' OR ')})`;
    return `(${gramPart} OR title: ${wordsOr} OR content: ${wordsOr})`;
}

/** 组装完整 MATCH：词条件 AND gram 条件；任一为空则用另一个。 */
export function buildMatch(q, { column = 'script_ngrams', wordColumns = ['title', 'content'], dropMixedWords = true } = {}) {
    const { word_text: wordText, gram_phrases: grams, mixed_adjacent } = analyzeScriptQuery(q);
    const parts = [];
    // ★ 混排 token 的 ASCII 段不交 porter（粘在 CJK 上搜不到），由 trigram 榜负责子串召回
    const useWords = wordText && !(dropMixedWords && mixed_adjacent);
    if (useWords) {
        const quoted = wordText.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).map((w) => `"${w.replace(/"/g, '""')}"`);
        if (quoted.length) {
            parts.push(`(${wordColumns.map((c) => `${c}: (${quoted.join(' ')})`).join(' OR ')})`);
        }
    }
    const gramExpr = gramMatchExpr(grams, column);
    if (gramExpr) parts.push(gramExpr);
    return parts.length ? parts.join(' AND ') : null;
}

/** 纯 CJK 判定：查询走哪条通道（Q-2）。 */
export function isPureScript(text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    return tokens.every((t) => [...t].every((ch) => isScriptChar(ch) || /[\p{M}\s]/u.test(ch)));
}

export function init() { /* 纯函数块 */ }
