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
 * 02-project — 项目目录定位 + 路径围栏 + sha256（kind: impl，deps: ['core']）
 *
 * 干什么：① 三态定 contentDir；② `isInside` 围栏（realpath + 带分隔符前缀比对）；
 *        ③ sha256；④ 目录遍历（上限/gitignore/符号链接逃逸拒绝）；⑤ 双库落点命名。
 * 为什么这样：围栏语义照 ref/security.js#isPathInsideProject（issue #852）与
 *            1.2.2 事故护栏逐条搬：词法判定为主闸，canonical（realpath）判定做
 *            纵深防御；symlink 指向根外 = 逃逸，拒绝。简化任何一步都会重开 #852。
 * 边界：不碰 SQLite（03）、不碰 DDL（04）；跨块只 import libs/。
 *
 * 对应需求：S-4（库文件布局）、P-14 落点约定。
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync, lstatSync, realpathSync, existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve, dirname, sep, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from '../../libs/err.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** <engine>/ —— 本块文件在 blocks/02-project/，往上两级就是 engine/。 */
const ENGINE_ROOT = resolve(HERE, '..', '..');

export const NAME = 'project';

/** walkDirectory 的默认边界（与 1.2.2 store-directory.js 一致，不另起炉灶）。 */
const DEFAULT_EXCLUDES = Object.freeze(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__', '.DS_Store']);
const DEFAULT_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.sh']);
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 200;

// ─────────────────────────────────────────────────────────
// ① contentDir 三态
// ─────────────────────────────────────────────────────────

/**
 * 定位内容库根目录，优先级（高→低）：
 *   opts.contentDir  >  env CONTEXT_MODE_DIR  >  兜底 <engine>/.content
 *
 * 兜底位放 engine 内部而不是 os.tmpdir：内容库要活过进程重启（14 天保留期），
 * 临时目录会被系统清；这一点与 1.2.2 的 <contentDir>/<hash>.db 布局对齐。
 *
 * @param {{contentDir?:string}} [opts]
 * @returns {string} 绝对路径（不保证存在，由调用方 mkdir）
 */
export function resolveContentDir(opts = {}) {
    const pick = opts.contentDir ?? process.env.CONTEXT_MODE_DIR;
    if (typeof pick === 'string' && pick.trim() !== '') {
        if (!isAbsolute(pick)) {
            // 相对路径当 contentDir 是配置事故：围栏根会随 cwd 漂移。拒绝，不猜。
            throw err('DENIED_PATH', { reason: 'contentDir 必须是绝对路径', got: pick });
        }
        return resolve(pick);
    }
    return join(ENGINE_ROOT, '.content');
}

// ─────────────────────────────────────────────────────────
// ② 路径围栏（#852 事故护栏，不许简化）
// ─────────────────────────────────────────────────────────

/** Windows/macOS 文件系统大小写不敏感，比对前先折叠。 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * canonical 解析：Windows 上必须走 `realpathSync.native`。
 *
 * 实测（本机 node v24.21.0）：`fs.realpathSync` 对 **junction**（`mklink /J`，
 * 创建它不需要管理员权限）原样返回词法路径，只有 `.native` 会解析到真实目标。
 * 围栏若只用 libuv 版，一个项目内的 junction 就能把任意目录"洗成"根内路径。
 * `.native` 不可用（老 runtime）时退回 libuv 版，仍比 symlink 逃逸有效。
 */
function canonical(p) {
    const fn = realpathSync.native ?? realpathSync;
    return fn(p);
}

function withinLexical(root, candidate) {
    let a = root;
    let b = candidate;
    if (CASE_INSENSITIVE) {
        a = a.toLowerCase();
        b = b.toLowerCase();
    }
    if (a === b) return true;
    // path.relative 是纯字符串运算：根内候选既不 `..` 开头也不是绝对形态。
    const rel = relative(a, b);
    if (rel === '') return true;
    if (rel === '..' || rel.startsWith('..' + sep)) return false;
    if (isAbsolute(rel)) return false; // 跨盘符（Windows）没法相对表达
    return true;
}

/**
 * `target` 是否围栏在 `root` 内。true = inside；越界一律 throw err('DENIED_PATH')。
 *
 * 两道闸（照 ref/security.js isPathInsideProject 的结构，逐条不许省）：
 *   1. 词法闸：resolve 后再比对，`..` 与绝对路径在这里就死；
 *      前缀比对走 relative()，天然带分隔符语义 —— `/../../evil` 不算 inside。
 *   2. 纵深闸：路径存在时用 realpathSync 再判一次 —— 项目内的
 *      `safe.log -> ~/.ssh/id_rsa` 这类符号链接逃逸在这道闸被拦下。
 *      文件还不存在（ENOENT）→ 词法判定作数（要创建的路径也得能用）。
 *
 * @param {string} root 围栏根（绝对或相对 cwd）
 * @param {string} target 待判定路径
 * @returns {true} 通过时恒为 true；越界不返回 false 而是 throw（调用方不用写重复的 if）
 */
export function isInside(root, target) {
    if (!root) throw err('DENIED_PATH', { reason: 'isInside(): root 不能为空', target });
    const r = resolve(root);
    const lex = resolve(r, target); // target 给绝对路径时 resolve 让它赢 → 词法闸会拒
    if (!withinLexical(r, lex)) {
        throw err('DENIED_PATH', { root: r, target: lex, stage: 'lexical' });
    }
    try {
        const canonicalRoot = canonical(r);
        const canonicalTarget = canonical(lex);
        if (!withinLexical(canonicalRoot, canonicalTarget)) {
            throw err('DENIED_PATH', { root: canonicalRoot, target: canonicalTarget, stage: 'realpath', why: '符号链接/junction 指向围栏外' });
        }
    } catch (e) {
        if (e && e.code === 'DENIED_PATH') throw e; // 纵深闸的拒绝不许被 catch 吞掉
        // ENOENT/EACCES 等：realpath 失败 → 退到「最近的**存在的**祖先」再判一次。
        //
        // ★ 为什么必须多这一下（2026-11-16 发布版修的真实漏洞）：
        //   围栏内放一个**断链**（指向围栏外、但目标还不存在的路径）时，
        //   canonical(lex) 抛 ENOENT → 原先直接按词法判定作数（放行）。
        //   但写操作会**跟着链接走** —— 目标一旦被创建，写入就落在围栏外。
        //   所以：realpath 失败时，从目标往上找第一个真实存在的祖先，
        //   把它 canonical 化后再跟围栏根比 —— 断链指向围栏外照样能看出来。
        const nearest = nearestExistingAncestor(lex);
        if (nearest !== null) {
            try {
                const canonicalRoot = canonical(r);
                const canonicalAncestor = canonical(nearest);
                if (!withinLexical(canonicalRoot, canonicalAncestor)) {
                    throw err('DENIED_PATH', {
                        root: canonicalRoot, target: nearest, stage: 'realpath',
                        why: '符号链接/junction 指向围栏外（断链，按最近存在的祖先判定）',
                    });
                }
            } catch (e2) {
                if (e2 && e2.code === 'DENIED_PATH') throw e2;
                // 连祖先都 realpath 不了（权限等）→ 词法判定作数（best-effort）
            }
        }
        // ★ 断链专案：lex **本身**就是一个符号链接（existsSync 为真、realpath 却失败）。
        //   这种链的目标可能根本不存在 ⇒ 上面的"最近存在的祖先"就是它自己 ⇒ 又失败 ⇒ 被吞。
        //   这里直接读链接目标，自己判断它是否落在围栏外：
        //     · 目标是相对路径 → 相对链接所在目录解析
        //     · 目标是绝对路径 → 直接判
        const linkTarget = readLinkTarget(lex);
        if (linkTarget !== null) {
            const resolved = isAbsolute(linkTarget)
                ? resolve(linkTarget)
                : resolve(dirname(lex), linkTarget);
            if (!withinLexical(r, resolved)) {
                throw err('DENIED_PATH', {
                    root: r, target: resolved, stage: 'realpath',
                    why: '符号链接/junction 指向围栏外（断链，按链接目标判定）',
                });
            }
        }
    }
    return true;
}

/**
 * 读路径上的符号链接目标（是符号链接才返回，否则 null）。
 * 读不出来（不是链接 / 权限）返回 null。
 *
 * @param {string} p
 * @returns {string|null}
 */
function readLinkTarget(p) {
    try {
        if (!lstatSync(p).isSymbolicLink()) return null;
        return readlinkSync(p);
    }
    catch {
        return null;
    }
}

/**
 * 从 `p` 往上找第一个**真实存在**的祖先目录（含自身）。
 * 不存在（ENOENT）就往上一级走；走到根都没有就返回 null。
 *
 * @param {string} p
 * @returns {string|null}
 */
function nearestExistingAncestor(p) {
    let cur = p;
    for (let i = 0; i < 64; i += 1) {
        try {
            if (existsSync(cur)) return cur;
        }
        catch { /* 继续往上一级 */ }
        const up = dirname(cur);
        if (up === cur) return null;
        cur = up;
    }
    return null;
}

// ─────────────────────────────────────────────────────────
// ③ sha256
// ─────────────────────────────────────────────────────────

/** 十六进制 sha256。长久库/内容库文件名（<hash>.db）与 content_hash 都走这一个口。 */
export function sha256(text) {
    return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────
// ④ 双库落点
// ─────────────────────────────────────────────────────────

/**
 * 库文件命名（S-4）：
 *   content → <contentDir>/<sha256(basename)前16位>.db    （项目内容库，14 天）
 *   memory  → <contentDir>/memory.persistent.db           （长久库，单库；.persistent 后缀被目录扫描排除）
 *   tmp     → <contentDir>/../Temp 不适用 —— 临时库走 12-lifecycle 的 PID 命名，
 *             这里只给"每会话临时内容库"的路径形态：<contentDir>/tmp-<pid>.db
 *
 * @param {string} contentDir resolveContentDir() 的结果
 * @param {'content'|'memory'|'tmp'} kind
 * @param {string} [id] content 形态必填（通常是 label 或文件路径）；memory/tmp 忽略
 */
export function dbPathFor(contentDir, kind, id) {
    // 只校验形态（绝对 + 非空）；围栏判定是 isInside 的事，这里不重复设闸。
    if (typeof contentDir !== 'string' || contentDir === '' || !isAbsolute(contentDir)) {
        throw err('DENIED_PATH', { reason: 'dbPathFor(): contentDir 必须是绝对路径', got: String(contentDir), kind });
    }
    switch (kind) {
        case 'content': {
            if (typeof id !== 'string' || id === '') throw err('DENIED_PATH', { reason: 'content 库必须给 id（label/路径）来定哈希名', kind });
            return join(contentDir, sha256(id).slice(0, 16) + '.db');
        }
        case 'memory':
            return join(contentDir, 'memory.persistent.db');
        case 'tmp':
            return join(contentDir, `tmp-${process.pid}.db`);
        default:
            throw err('DENIED_PATH', { reason: `dbPathFor(): kind 只认 content/memory/tmp，收到 ${kind}` });
    }
}

// ─────────────────────────────────────────────────────────
// ⑤ 目录遍历（移植 1.2.2 store-directory.js，语义不变）
// ─────────────────────────────────────────────────────────

function globToRegExp(pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i++;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if ('\\^$.|+()[]{}'.includes(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    return new RegExp(`^${re}$`);
}

/**
 * 目录排除 / 包含清单的匹配（`DEFAULT_EXCLUDES`、调用方的 `exclude` / `include`）。
 * ★ 这部分**不是** `.gitignore` 语义：它是"简单模式清单"，无 `!`、无逐层 base。
 *   2026-11-14 项目 07 只把 `.gitignore` 拆出去，这条原样保留（行为一字未改）。
 */
function matchesAny(relPosix, patterns) {
    if (patterns.length === 0) return false;
    const basename = relPosix.split('/').pop() ?? relPosix;
    for (const p of patterns) {
        if (!p.includes('/') && !p.includes('*')) {
            if (basename === p) return true;
            if (relPosix.split('/').includes(p)) return true;
            continue;
        }
        const re = globToRegExp(p);
        if (re.test(relPosix) || re.test(basename)) return true;
    }
    return false;
}

/**
 * ★★ 2026-11-14（项目 07）：`.gitignore` **逐层 + 反选**（对齐第三方 /`src/core/index/walk.ts`）。
 *
 * 修前的三处硬错（全部实测可复现）：
 *   ① **只读根目录一层** —— 子目录 `src/.gitignore` 完全不被读；
 *   ② **`!` 反选行被整行丢掉**（`filter(l => ... && !l.startsWith('!'))`）⇒ 项目里
 *      `*.log` + `!keep.log` 这种"先排后放"的写法在我们的遍历里**永远放不出来**；
 *   ③ `/` 锚定、`dir/` 目录专属、`\x` 转义一律不认，一律当普通通配。
 *
 * 现在按规范语义实现（不是"差不多"）：
 *   · 规则带 `base`（写它的那个目录，相对遍历根）—— 子目录规则只作用于该子树；
 *   · `!` = 反选（**最后一条匹配的规则赢**，与 git 一致）；
 *   · 前导 `/` = 只在 `base` 下匹配，否则在 `base` 以下任意深度匹配；
 *   · 尾随 `/` = 只匹配目录；
 *   · `**` 段 = 零或多段；**尾随 `**` = 一段或多段**（`build/**` 不排掉 `build` 自己，
 *     这样 `!build/keep.txt` 还能把它拉回来 —— 与 upstream `matchSegs` 同款）；
 *   · `\x` = 字面量 x。
 *
 * ★ 有意保留的一条差别：遍历**无文件数上限**的话，我们加了 `maxFiles`。
 *   工作区根目录会被扫穿（临时区里几十个垃圾目录）。上限保留，`capped` 照报。
 */

/** 一条 .gitignore 规则。`base` = 写它的目录（相对遍历根的段数组）。 */
function parseRule(raw, base) {
    let line = String(raw).replace(/\r$/, '');
    // 行尾未转义的空格不算内容（git 同款）
    let end = line.length;
    while (end > 0 && line[end - 1] === ' ' && !(end > 1 && line[end - 2] === '\\')) end -= 1;
    line = line.slice(0, end);
    if (line.length === 0 || line.startsWith('#')) return undefined;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const parts = line.split('/').filter((p) => p !== '');
    if (parts.length === 0) return undefined;
    return { base, parts, negate, dirOnly, anchored };
}

/**
 * 读某个目录下的 `.gitignore`（读不到/没有 → 空）。
 * @param {string} dirAbs 目录绝对路径
 * @param {string[]} base 该目录相对遍历根的段数组
 * @returns {Array<object>}
 */
function readRules(dirAbs, base) {
    const giPath = join(dirAbs, '.gitignore');
    let body;
    try { body = readFileSync(giPath, 'utf-8'); }
    catch { return []; }
    const out = [];
    for (const raw of body.split('\n')) {
        const rule = parseRule(raw, base);
        if (rule !== undefined) out.push(rule);
    }
    return out;
}

/** 一条规则是否命中（`segs` = 候选条目相对遍历根的完整段数组）。 */
function ruleMatches(r, segs) {
    if (segs.length <= r.base.length) return false;         // 规则只管自己下面
    for (let i = 0; i < r.base.length; i += 1) {
        if (segs[i] !== r.base[i]) return false;
    }
    if (r.anchored) return matchSegs(r.parts, 0, segs, r.base.length);
    // 非锚定：在 base 以下的**任意起点**都能开始匹配（= git 的"任意深度"）
    for (let from = r.base.length; from < segs.length; from += 1) {
        if (matchSegs(r.parts, 0, segs, from)) return true;
    }
    return false;
}

/** 整路径匹配：`**` 吞零或多段；**尾随 `**` 吞一段或多段**（upstream 同款）。 */
function matchSegs(pat, p, segs, s) {
    if (p === pat.length) return s === segs.length;
    if (pat[p] === '**') {
        const first = p === pat.length - 1 ? s + 1 : s;
        for (let k = first; k <= segs.length; k += 1) {
            if (matchSegs(pat, p + 1, segs, k)) return true;
        }
        return false;
    }
    return s < segs.length && globSeg(pat[p], segs[s]) && matchSegs(pat, p + 1, segs, s + 1);
}

/** 单段匹配：`*` = 任意串，`?` = 一个字符，`\x` = 字面量 x。回溯到最后一次 `*`。 */
function globSeg(pat, name) {
    let p = 0; let n = 0;
    let star = -1; let mark = 0;
    while (n < name.length) {
        if (p < pat.length && pat[p] === '*') {
            star = p; mark = n; p += 1;
        }
        else if (p < pat.length && pat[p] === '\\' && p + 1 < pat.length && pat[p + 1] === name[n]) {
            p += 2; n += 1;
        }
        else if (p < pat.length && pat[p] !== '\\' && (pat[p] === '?' || pat[p] === name[n])) {
            p += 1; n += 1;
        }
        else if (star >= 0) {
            p = star + 1; mark += 1; n = mark;
        }
        else return false;
    }
    while (p < pat.length && pat[p] === '*') p += 1;
    return p === pat.length;
}

/**
 * 忽略判定：**最后一条匹配的规则赢**（git 语义）。`!` 规则可以把已排除的条目拉回来。
 *
 * ★ 能"拉回来"的前提是**父目录没被排除**：被排除的目录根本不进去（`visit` 里直接 continue），
 *   这与 git 的 "It is not possible to re-include a file if a parent directory of that file
 *   is excluded" 完全一致 —— 不是我们的取舍，是规范。
 *
 * @param {Array<object>} rules 当前路径上累积的全部规则（根→当前，按写入顺序）
 * @param {string[]} segs 条目相对遍历根的段数组
 * @param {boolean} isDir
 */
function isIgnored(rules, segs, isDir) {
    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const r = rules[i];
        if (r.dirOnly && !isDir) continue;
        if (ruleMatches(r, segs)) return !r.negate;
    }
    return false;
}

function toPosixRel(rootPath, absPath) {
    return relative(rootPath, absPath).split(sep).join('/');
}

/**
 * 有界递归遍历。返回 { files, capped, totalSeen }（1.2.2 同款三件套，
 * capped/totalSeen 让调用方能把"目录太大只收了一部分"说给用户听）。
 *
 * 硬语义（不许省）：
 *   - 根先 realpath，符号链接逃逸（resolve 后离开根）的条目静默跳过；
 *   - followSymlinks=false 时符号链接一律不收（默认）；
 *   - 环检测用 visited(realpath Set)；
 *   - maxFiles 截断 = capped=true，不是 throw。
 */
export function walkDirectoryDetailed(rootPath, opts = {}) {
    const {
        include,
        exclude,
        maxDepth = DEFAULT_MAX_DEPTH,
        maxFiles = DEFAULT_MAX_FILES,
        extensions,
        respectGitignore = true,
        followSymlinks = false,
    } = opts;

    let rootReal;
    try {
        rootReal = canonical(rootPath);
    } catch {
        return { files: [], capped: false, totalSeen: 0 };
    }
    const exts = (extensions && extensions.length > 0 ? extensions : DEFAULT_EXTENSIONS)
        .map((e) => (e.startsWith('.') ? e : '.' + e).toLowerCase());
    // ★ 2026-11-14 项目 07：`excludes` 只剩"硬编码排除 + 调用方追加"，
    //   `.gitignore` 不再混进这个扁平数组 —— 它有自己的逐层规则表（`rules`）。
    //   混在一起的后果就是修前那三处错（见 `parseRule` 上方的长注释）。
    const excludes = [...DEFAULT_EXCLUDES, ...(exclude ?? [])];
    const includes = include ?? [];
    const out = [];
    const visited = new Set([rootReal]);
    let totalSeen = 0;
    let capped = false;

    /**
     * @param {string} absDir 当前目录绝对路径
     * @param {number} depth
     * @param {Array<object>} parentRules 根→父目录累积的 `.gitignore` 规则
     * @param {string[]} relSegs 当前目录相对根的段数组
     */
    function walk(absDir, depth, parentRules, relSegs) {
        if (capped || depth > maxDepth) return;
        let entries;
        try {
            entries = readdirSync(absDir, { withFileTypes: true });
        } catch {
            return; // 不可读目录：跳过（照 1.2.2，不炸整个遍历）
        }
        // ★ 逐层：本目录若有 `.gitignore`，接在父规则后面（子规则优先，因为"最后匹配赢"）。
        const rules = (respectGitignore && entries.some((e) => e.name === '.gitignore' && e.isFile()))
            ? parentRules.concat(readRules(absDir, relSegs))
            : parentRules;
        for (const ent of entries) {
            if (capped) return;
            const absChild = join(absDir, ent.name);
            const relPosix = toPosixRel(rootReal, absChild);
            const childSegs = relSegs.concat(ent.name);
            if (matchesAny(relPosix, excludes)) continue;

            let isDirChild = ent.isDirectory();
            let isFileChild = ent.isFile();
            let isSymlink = false;
            try {
                isSymlink = lstatSync(absChild).isSymbolicLink();
            } catch {
                continue;
            }
            if (isSymlink) {
                if (!followSymlinks) continue;
                let resolvedTarget;
                try {
                    resolvedTarget = canonical(absChild);
                } catch {
                    continue; // 悬空链接
                }
                // 逃逸判定：relative 以 .. 开头 = 目标在根外 → 跳过
                const escapeRel = relative(rootReal, resolvedTarget);
                if (escapeRel === '..' || escapeRel.startsWith('..' + sep)) continue;
                if (visited.has(resolvedTarget)) continue; // 环
                visited.add(resolvedTarget);
                try {
                    const st = statSync(resolvedTarget);
                    isDirChild = st.isDirectory();
                    isFileChild = st.isFile();
                } catch {
                    continue;
                }
            }
            if (isDirChild) {
                // junction 逃逸：Windows 的 `mklink /J` 在 lstat 里报"目录"而非
                // symlink，所以软链那段判定盖不住它。这里对每个目录子项算一次
                // canonical：若解析后离开根，直接跳过（与符号链接逃逸同一纪律）。
                try {
                    const dirReal = canonical(absChild);
                    const esc = relative(rootReal, dirReal);
                    if (esc === '..' || esc.startsWith('..' + sep) || (esc !== '' && isAbsolute(esc))) continue;
                } catch {
                    continue; // 读不动的目录：跳过
                }
                // ★ 目录被 .gitignore 排除时**根本不进去**（git 同款语义：
                //   父目录被排除，里面的文件就无法再被 `!` 拉回来）。
                if (isIgnored(rules, childSegs, true)) continue;
                walk(absChild, depth + 1, rules, childSegs);
                continue;
            }
            if (!isFileChild) continue;
            if (isIgnored(rules, childSegs, false)) continue;
            if (!exts.includes(extname(absChild).toLowerCase())) continue;
            if (includes.length > 0 && !matchesAny(relPosix, includes)) continue;
            totalSeen++;
            if (out.length >= maxFiles) {
                capped = true;
                return;
            }
            // ★ 2026-11-16 发布版修：把**相对路径**一起带出去。
            //   relPosix 是相对 rootReal（realpath 后的根）算的 —— 正确口径。
            //   以前调用方（08-writer）拿 root 的**原值**再算一次相对路径，
            //   而 Windows 上 TEMP 常是 8.3 短路径（`C:\Users\RUNNER~1\...`），
            //   realpath 给出的是长路径（`C:\Users\runneradmin\...`）——
            //   两者字符串不同 ⇒ 相对路径算不出来 ⇒ label 退成绝对路径 ⇒ 不可移植。
            //   现在由遍历层直接给出相对路径，调用方不再重算。
            out.push({ path: absChild, rel: relPosix });
        }
    }

    walk(rootReal, 0, respectGitignore ? readRules(rootReal, []) : [], []);
    return { files: out.map((f) => f.path), fileEntries: out, capped, totalSeen };
}

/** 便捷面：只要文件清单。 */
export function walkDirectory(rootPath, opts = {}) {
    return walkDirectoryDetailed(rootPath, opts).files;
}

/** 本块不变量。 */
export const INVARIANTS = Object.freeze([
    'resolveContentDir 三态优先级 opts > env > 兜底，非绝对路径一律 throw',
    'isInside 词法+realpath 双闸；越界 throw DENIED_PATH（不返回 false）',
    'sha256 与 node:crypto createHash 完整节一致',
    'walkDirectoryDetailed 不跟随逃逸符号链接、不穿越环、maxFiles 截断报 capped',
]);

/** 块初始化：定根、挂进 ctx（后续块从 ctx.contentDir 拿，不再各自解析 env）。 */
export async function init(ctx) {
    const contentDir = resolveContentDir({ contentDir: ctx.contentDir });
    ctx.contentDir = contentDir;
    ctx.project = { NAME, isInside, sha256, dbPathFor, walkDirectoryDetailed };
    return { name: NAME, contentDir };
}
