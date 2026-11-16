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
 * Pre-compaction transcript archiving for DSH.
 *
 * Compaction replaces the live conversation with a generated summary and
 * prunes the events behind it, so anything the summary omits is gone from the
 * model's reach. This listener captures the transcript as compaction begins
 * and files it into the context-mode knowledge base, where `ctx_search` can
 * retrieve it afterwards.
 *
 * Storage is LAYERED rather than filtered. Every event is archived; the layers
 * differ only in the `source` label they carry, so a caller chooses precision
 * at query time:
 *
 *   session/<id>/constraint   user messages — requirements, decisions, limits
 *   session/<id>/finding      tool results — commands run and what they showed
 *   session/<id>/narrative    assistant prose — reasoning, plans, restatement
 *
 * Nothing is dropped at write time. A message the classifier files as
 * narrative is still present, so a misclassification costs a query's
 * precision rather than the content itself. That is the property a filter
 * would not have.
 *
 * The listener is a best-effort passenger on the compaction path: it never
 * throws, never blocks, and can be disabled by configuration.
 */
import { segmentCjk } from './cjk.js';
/**
 * ★ 2026-11-04 P4：`segmentCjk` **不再用于写入侧**（最终定义 §2.2「调用方不再调 segmentCjk」）。
 *   保留 import 是为了不让 lint 抱怨未用变量会报错 —— 实际上这个 import 现在没有使用者，
 *   所以直接删掉；`buildCjkQuery` 那条查询侧兜底在引擎 06-gram 里，不在这里。
 *   （引擎的 gram 通道在写入侧就把汉字分好了，桥侧再铺一遍 = 两份实现。）
 */
void segmentCjk;   // ← 保留引用，明确"这个件还在，但写入侧不再用它"（查询侧兜底未来可能用）
/** Layer names appended to the session-scoped source label. */
export const LAYERS = {
    constraint: 'constraint',
    finding: 'finding',
    narrative: 'narrative',
};
const DEFAULT_MAX_CHARS_PER_LAYER = 120_000;

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-11 批次1（05-R11 乙案／终稿 §6.1、§6.2）：**道 B L1 流程链**
//
//   维护方 17:12 原话（终稿 §六 头部）：「系统压缩给你的是陈述……甚至连讨论顺序
//   前因后果都分不出来……换成一条我们通过整理出来的流程呢？」
//   ⇒ L1 流程链 ＝ **有序**的真人环链，带"为什么变成这样"，不是"还剩什么"。
//
//   ★ A 案（本窗 §二 定案）：**压缩时算、存进 notice、渲染只读**。
//     理由＝`archive()` 在这一步已经拿全了 events（`:360`）并跑过 `classify()`（`:371`），
//     流程链只是这份 `lines` 的另一个视图；每渲染现算会把全量分类搬进热路径
//     （`session-memory.js:100–106` 那条 68 轮 660 KB 的旧事故）。
//
//   预算（§6.1 表 L1 行 + §6.2 上界公式，两者必须自洽）：
//     典型 581 B ／ **硬上界 933 B**。
//     上界公式（写死，禁止用"N^0.87 幂律"做容量规划——§6.2 判据 8 实测链长对环数**非单调**）：
//       `ME×41 + K×109 + 分隔`  ＝ 6×41 + 6×109 ＝ 900，加分隔符 ⇒ 933。
//     ★ K＝6 ⇒ 每个近端环整条 ≤109 B 形态（声明 ≤100 B 整条，超了走"首12+…+末12"）；
//       ME＝6 ⇒ 每个远端段 `⟨a-b⟩`＋8 字主旨 ≤41 B。
// ─────────────────────────────────────────────────────────
/** 近端环数（§6.1：K=6）。 */
export const CHAIN_NEAR_K = 6;
/** 近端单环整条上限（字节）。 */
export const CHAIN_NEAR_RING_MAX_BYTES = 100;
/** 近端超上限时的"首 N 字符＋…＋末 N 字符"（§6.1）。 */
export const CHAIN_NEAR_EDGE_CHARS = 12;
/** 远端段数上限（§6.1：递归至 ME=6）。 */
export const CHAIN_MERGE_MAX = 6;
/** 远端并段比例（§6.1：3 并 1）。 */
export const CHAIN_MERGE_RATIO = 3;
/** 远端段主旨字数（§6.1：8 字主旨）。 */
export const CHAIN_MERGE_TOPIC_CHARS = 8;
/** L1 硬上界（§6.1 表；门 ⑳ 断言用）。 */
export const CHAIN_MAX_BYTES = 933;

// ─────────────────────────────────────────────────────────
// ★★★ 2026-11-14 项目 07 追加（说明：「追加在07里完成就行，留有用的」）：
//   **常驻五层退役**——L6 台账／L2 常量／L3 状态／L4 已证伪／L5 异常。
//
//   为什么退（逐条实证，不是嫌它占地方）：
//     ① **L6 台账**＝`LEDGER_LINE` 硬编码字符串，**没有任何代码会更新它**。它写「门32」，
//        而实况是 12 个门、项数 17/19/12/13/11/11/32/19/5/13/9/5 —— 「门32」把
//        push-channels 的项数当成了门数。它宣称的"追账"是门外断言，自己永远不动。
//        尾巴 `@231,1513,2633` 无任何可解析语义，本会话零次被用。
//     ② **L2 常量**＝`renderConsts()` 硬编码四个值，其中 `DF=.5主题级` 的真源是
//        `recall-hints.js` 的 `DF_TOPIC_RATIO`，而该文件随道 A 一并删除（07 上半场）。
//        ⇒ 常驻体在宣传一个**已不存在的参数**。且读者是改代码的人，不是每一步的模型。
//     ③ **L3 状态**＝取最新 `todo_write`。本会话实测输出「未闭7/7：…建 07 项目文件夹、
//        改入库筛选」——这三件事**全部已完成**。道 B 记的是压缩那一刻的运行时状态，
//        而状态腐坏最快；过 300 步它还在，会骗着模型去重做已完成的活。
//        跨会话待办有 `Tasklog\PENDING.md` 承担，这里是双份账本，必然对不上。
//     ④ **L4 已证伪**＝正则抓证伪词。两个实伤（修前 `renderRefuted` 内）：(a) 三元
//        `? '实测否' : '实测否'` 两边一字不差＝死分支；(b) `m[1].slice(-14)` 取句尾 14 字拼出
//        `✗了。**"不停注入"这个说法→实测否`，前头挂个孤零零的"了。"，正常应为
//        `✗"不停注入"这个说法→实测否`。取错片段＋写等于没写。
//     ⑤ **L5 异常**＝只要 `tool/result.isError===true` 就记。`WRITE_OUTSIDE_SAN`
//        是 workspace-write 策略下的**正常拒绝**不是故障；`失败11件` 这数只增不减，
//        没有一条需要模型处理。
//
//   量：五层上界合计 120+161+110+153+93＝637 B，实测约 530 B，**每步都带**。
//     本会话 517 步 ⇒ 约 274 KB 纯噪声随每个 prompt 走。
//
//   留什么：L1 流程链（939 B 级，实测救场——让我知道九轮问了什么）
//         ＋ card 取原文指针（188 B，`[archive] 完整正文：ctx({op:"recall", source:"…"})`
//           带确切 source 与可直接抄的命令）。
//   Σ上界＝933+188 ＝ **1,121 B**（原 1,758，减 637）。
// ─────────────────────────────────────────────────────────
/** card＋取原文指针上界（§6.1：典型 188 B＝cap）。 */
export const CARD_MAX_BYTES = 188;
/** 常驻体总硬上界（Σ各层；门断言 ≤ RECAP_MAX_BYTES）。2026-11-14：1,758 → 1,121（五层退役）。 */
export const RESIDENT_MAX_BYTES = 1121;

/** 把单层裁到它的硬上界（不劈码点）。cap 掉的部分计入 droppedLayers，供门/遥测看。 */
function capLayer(s, max) {
    const t = String(s ?? '');
    if (t.length === 0) return { text: '', clipped: false };
    if (Buffer.byteLength(t, 'utf8') <= max) return { text: t, clipped: false };
    return { text: capBytesUtf8(t, max), clipped: true };
}

/**
 * ★★★ 2026-11-14 项目 07 追加：`capLayerMarked` 已退役删除。
 *   它是"层内自封顶"的出口，专为 L2～L6 五个渲染器服务；五层退役后**零调用方**，
 *   一并删除（留着就是死代码，和"台账里写不存在的常量"同一类病）。
 *   `capLayer`（不带 '…' 标记的那支）仍在用：L1 链和 card 走它。
 */
/**
 * ★★ 2026-11-11 批次1（05-R11 乙案）：组装**常驻体**。落 archivePointer 侧、**绝不进 playback**。
 *   每层截到自己的 cap（⑳ BOUND-PROOF 断言 byteLength ≤ 声明上界），Σ 上界 ≤2,048。
 *   ★ A 案：压缩时算好存 notice，渲染只读（不在每渲染重算）。
 *   ★ card 里的"取原文指针"值必须指"首个已归档事件 seq"（§6.1 实测 turn/start 命中 0/8，
 *     所以用 mapSource 而非 seq）。
 *
 * ★★★ 2026-11-14 项目 07 追加：**只剩两层** —— L1 流程链 ＋ card 取原文指针。
 *   原六层（＋L6 台账／L2 常量／L3 状态／L4 已证伪／L5 异常）全部退役，
 *   逐条实证见本文件顶部 `RESIDENT_MAX_BYTES` 上方的长注释。
 *   Σ上界 1,758 → **1,121**（933+188）。
 *   ★ 保留判据只有一条：**压缩掉就再也找不回来的东西**。
 *     L1 链＝"我刚才丢了哪几轮"（零成本恢复不了，只能从这个链知道去 recall 谁）；
 *     card＝可直接抄的 recall 命令（含确切 source）。
 *     其余五层全是**运行时状态的快照**，而状态腐坏最快、且都能由模型自己 2 秒内重算
 *     （todo 在手、门项数跑一遍门就知道、常量 grep 一下就有）⇒ 常驻它们＝拿最贵的
 *     每步预算去存最便宜的东西。
 */
export function renderResident(events, opts = {}) {
    const rings = humanRings(events);
    const layers = [];
    const caps = [];
    const push = (capName, s, max) => {
        const { text, clipped } = capLayer(s, max);
        if (text.length > 0) { layers.push(text); caps.push({ capName, bytes: Buffer.byteLength(text, 'utf8'), max, clipped }); }
    };
    push('L1', buildFlowChain(rings), CHAIN_MAX_BYTES);
    const card = opts.card ? capLayer(opts.card, CARD_MAX_BYTES) : null;
    if (card && card.text.length > 0) { layers.push(card.text); caps.push({ capName: 'card', bytes: card.text.length, max: CARD_MAX_BYTES, clipped: card.clipped }); }
    return {
        text: layers.join('\n'),
        bytes: Buffer.byteLength(layers.join('\n'), 'utf8'),
        caps,
        rings: rings.length,
    };
}

/** Events that carry transcript value and are therefore buffered. */
const CARRIES_TRANSCRIPT = new Set([
    'user/message',
    'assistant/message',
    'tool/result',
]);
/** Buffered events per session before the oldest are dropped. */
const MAX_BUFFERED_EVENTS = 2_000;
/** local.6: cap for the per-compaction archive-map document. */
const MAX_MAP_CHARS = 45_000;
/** local.8: how many per-event rows the map lists before summarising the rest. */
const MAX_MAP_ROWS = 800;
/**
 * local.8: a layer is filed as sequential parts of at most `maxCharsPerLayer`
 * characters each. local.6/7 kept only the first part and silently skipped
 * every event that arrived after the layer's budget was spent — in practice a
 * handful of large tool results filled `finding`, so most of the session was
 * never indexed while the pointer still claimed it had been. Splitting keeps
 * the whole span searchable; MAX_LAYER_PARTS is the real ceiling and whatever
 * it cannot hold is counted and reported instead of hidden.
 */
const MAX_LAYER_PARTS = 8;
/**
 * local.6: per-session archive notices, written when an archive flush
 * succeeded and read synchronously by the prompt-injection section. Keyed by
 * the same session id the source labels use. A session with no entry has never
 * had a successful archive, so its injection stays empty (zero cost).
 */
const notices = new Map();
/**
 * local.7: per-session set of event seqs already filed, so a flush that reads
 * the whole transcript never re-indexes history an earlier flush covered.
 * Keyed by the session object (the same key the event buffer uses).
 */
const archivedSeqs = new WeakMap();
/** local.6: the archive notice for one session id, or undefined. */
export function archiveNotice(sessionId) {
    return notices.get(sessionId);
}

/**
 * ★★ 2026-11-09 M4（04-修复道AB故障）：道 B 回放预算 —— **字节**，不是 UTF-16 码元。
 *
 *   修前 `precompact.js:134` 是 `body.length > 2048 ? body.slice(0,2048)+'…'`：
 *   `.length` 数的是码元，中文每个字 1 个码元但 3 个字节 ⇒ 实测截完 **6,147 B**，
 *   口径（S-6「预算 ~2048 B」）被超了 3 倍。门用的是**正确**的字节判据
 *   （`Buffer.byteLength(recap.text) <= 2048`），但它只测死件 `10-recall.recallCompacted`，
 *   活件从来没人测 —— 这一条就是 B4「门测死件」的直接后果。
 *
 *   数值真源：`engine/blocks/10-recall/index.js:26` 的 `RECAP_MAX_BYTES`（另有
 *   `01-core/index.js:29`、`Oldversion\任务书A-存储四块.md:47` 同值）。它 export 不了
 *   —— ours 侧 import engine 会打破"平台无关引擎 + 适配层"的分层，且 T-11 判据禁止
 *   道 A/道 B 互相 import。所以这里**按真源值对齐**并注明出处；改真源时必须同步。
 */
const RECAP_MAX_BYTES = 2048;

/** 按字节截断且**不劈码点**（做法与道 A 那个 capBytes 同形，但**不能 import 它** —— 两池必须独立，T-11）。 */
function capBytesUtf8(s, max) {
    if (Buffer.byteLength(s, 'utf8') <= max) return s;
    let out = '';
    let bytes = 0;
    for (const ch of s) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (bytes + b > max) break;
        out += ch;
        bytes += b;
    }
    return out;
}

/**
 * ★★ 2026-11-09 M7：道 B 的**活件遥测**（修前 `stats.hints` 里根本没有 seenB/playback 数）。
 *   与 S9.44 给道 A 接 `hintState` 完全同型：由 platform 把本函数递给引擎
 *   （`seams.hintState` / `engine-client` / `16-entry` / `14-tools:782-793`），
 *   `op:stats` 的 hints 行才有道 B 的真数，而不是 `10-recall` 那个零调用方死池的恒 0。
 */
const playbackSeen = new Set();   // 已回放过的块身份（本进程，跟 seenB 同语义）
const playbackStats = { built: 0, shown: 0, seedCollapse: 0 };

/** 道 B 生产池遥测（供 `op:stats` 的 hints 行合并）。 */
export function playbackState() {
    return {
        seenB: playbackSeen.size,
        playbackCount: playbackStats.built,   // 造过几次回放（每次压缩一次）
        playbackShown: playbackStats.shown,   // 真被 prompt 段取走几次
        // ★ 2026-11-11 批次1（P-23 10a）：seed 去重后塌成更少条的次数（选材失效信号，
        //   非零即异常；门判据「queries 去重后塌成 1 条须报警」读这一格）。
        seedCollapse: playbackStats.seedCollapse,
    };
}

/**
 * ★ 2026-11-04 P5（道 B 接线）：把道 B 回放从通知里**取走一次**（取走即清）。
 *
 * 为什么"取走即清"：一次压缩只推一次。prompt 注入段每次请求都会被调用，
 * 若不清，同一条回放会在**每一轮**重复出现 → 白烧上下文（1.0.2 的教训：
 * 动态上下文每轮变 → 整份 runtime snapshot 重发）。
 *
 * ★★★ 2026-11-09 M9：这里的"取走即清"**保持不变**。
 *   宿主在同一个请求里对 prompt 上下文求值两次（assemble + refreshContext），
 *   提交给模型的是第二次那份 —— 这件事的修法**不在本池**，而在注入层
 *   （`session-memory.js` 的粘性窗口 + 内容指纹 stamp）。
 *   理由：道 B 的语义（一次压缩推一次）必须保持纯朴，
 *   一旦这里改成"可重复读"，道 A/道 B 两个池的语义就分家了。
 *
 * @param {string} sessionId
 * @returns {string|undefined} ≤2048 B 的回放文本；没有（或已取过）→ undefined
 */
export function consumePlayback(sessionId) {
    const notice = notices.get(sessionId);
    if (notice === undefined || notice.playback === undefined) return undefined;
    const text = notice.playback;
    notices.set(sessionId, { ...notice, playback: undefined });
    playbackStats.shown += 1;
    return text;
}

/**
 * ★ P5：造一次道 B 回放（S-6「压缩后把 recap 卡 + ≤2 整块 + 指针推回去」）。
 *
 * 用引擎自己的 `op:"recall"` 取内容（三榜 RRF + 窗口化截断都在那边，不在这里重写）。
 * 预算 ~2048 B：回放文本必须**短**，它不是正文载体，是"这里有你刚才丢的东西"。
 *
 * @param {{callTool:Function}} client 平台层给下来的引擎客户端
 * @param {string} key 会话 id
 * @param {string} mapText 本批次的归档地图（当指针用）
 * @returns {Promise<string|undefined>}
 */
/**
 * ★★ 2026-11-09 M5：从本批次**真归档的正文**里取检索线索（道 B 查询词的正确来源）。
 *
 * 为什么不是地图行的标题：地图行的 head 是 `heading()` 造的
 * （`## [结论] tool (seq 33)` / `## [约束] 用户 (seq 11)`）—— 剥掉标签与 seq 只剩
 * 「tool」「用户」，那是**事件种类**不是内容，拿去检索等于没检索。
 * 真正能回答"刚才丢了什么"的，是本批次里**字数最多**的那几条正文的首段。
 *
 * @param {Array<{text:string,layer:string}>} lines classify 的产物
 * @param {Set<number>} filed 真正写进库的行号
 * @param {number} [limit] 最多取几条（道 B 只要 2 条）
 * @returns {string[]} 按正文字数降序取出的查询词
 */
function contentSeeds(lines, filed, limit = 2) {
    const rows = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (!filed.has(index)) continue;
        const line = lines[index];
        // 跳过标题行（heading 在正文首行），取正文主体
        const nl = line.text.indexOf('\n');
        const body = nl === -1 ? '' : line.text.slice(nl + 1);
        const flat = body.replace(/\s+/g, ' ').trim();
        if (flat.length === 0) continue;
        // ★★ 2026-11-11 批次1（05-R10／P-23 10a 必要条件）：排除以 `<path>`/`<type>` 开头的
        //   工具回执正文。一手实测（终稿 §6.3 第 10 条）：`contentSeeds` 按 chars 降序取最长，
        //   而最长的一批恒是 tool/result 的大段 XML 回执 ⇒ seed1/seed2 都塌成 `"<path>F:\workspace\LongM`
        //   同一路径前缀 ⇒ queries 去重后**只剩 1 条**，回放推的是"路径前缀撞上的噪声"。
        //   ★ 这只是**必要条件**（10a），单独存在仍红：真正修好要 10b 把选材维度从
        //   "取最长"换成"主题词导向"，那属批次 2 的 P-18（摘要节首选），本批不做。
        if (/^\s*<(?:path|type)\b/.test(flat)) continue;
        rows.push({ chars: flat.length, text: flat });
    }
    rows.sort((a, b) => b.chars - a.chars);
    return rows.slice(0, limit).map((r) => r.text.slice(0, SEED_MAX_CHARS));
}
/** 单条查询词上限（FTS 逐词查，太长只是噪声；也防把整篇正文灌进查询）。 */
const SEED_MAX_CHARS = 24;

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-11 批次1（05-R9／终稿 §6.3 第 10b 跨层不变式订正）：
//   旧不变式「凡下游截断 L，宿主剪点 P ≥ L+1 ⇒ 道 B 天然免疫 pruner」**不成立**
//   （实测 22 条超阈值 tool/result 里 9 条读取窗口已越过剪点 4096；病根＝量纲不同：
//    宿主按原始码点、我方按折叠空白后的 UTF-16 单元）。
//   ⇒ 换成**实测式主判据**：直接搜宿主 pruner 留下的**核心子串**（不含空白、折叠后仍在）。
//   ★ 主判据用核心子串，**不是**含换行的字面串 ——
//     `textOf` 的 clip 把一切空白折成单空格 ⇒ 含换行字面串在任何输入下恒不命中＝恒绿假门
//     （§6.3 原话"错的判据不会报错，它在真闸失效时抢着报绿"）。
// ─────────────────────────────────────────────────────────
/** 宿主 pruner 改写标记的**核心子串**（无空白，折叠后仍可命中 ⇒ 主判据）。 */
export const PRUNE_MARKER_CORE = 'tool result middle pruned';
/**
 * 检测一份正文里是否混进了宿主 pruner 的改写标记。
 * @param {string} text 已 clip/折叠过的文本（textOf 产物）或原始正文皆可
 * @returns {boolean}
 */
export function containsPruneMarker(text) {
    return String(text ?? '').includes(PRUNE_MARKER_CORE);
}
/**
 * 预警式（§6.3 替换式，**不作定案**）：`W_right = 原始码点位置 − 1`，超 headChars−1 预警。
 * 归一化后第 L 个字符对应的原始码点位置：沿原串走，数折叠掉的空白。
 * @param {string} raw 原始正文（未 clip）
 * @param {number} L 我方窗口字符数（默认 3999，clip 是 slice(0,max-1)+'…'）
 * @returns {number} W_right（原始码点右端偏移）
 */
export function windowRawCodepoint(raw, L = 3999) {
    const s = String(raw ?? '');
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= L) return s.length;   // 没截到窗口 ⇒ 原始即上界
    // 找折叠后第 L 个字符，映射回原始码点位置
    let src = 0, out = 0, prevWs = false;
    while (src < s.length && out < L) {
        const isWs = /\s/.test(s[src]);
        if (!(isWs && prevWs)) { out += 1; }
        prevWs = isWs;
        src += 1;
    }
    return src - 1;   // W_right = rawCpAtL − 1（换算式写死）
}


/**
 * ★★ 2026-11-09 M7：导出给门用（`engine/verify/push-channels.mjs` 的道 B 活件判据）。
 *   修前这个函数是模块私有的，门只能去测 `10-recall.recallCompacted` 那个**零调用方死件**
 *   —— 这正是 B4「门测死件」的成因。导出它，门才能对**生产真件**下判据
 *   （字节预算 / 查询词来源 / 覆盖竞态全在它身上）。
 */
export { buildPlayback };
/**
 * ★★ 2026-11-11 批次1（P-23 10a）：一并导出 `contentSeeds`，门才能对**选材**下判据。
 *   与 M7 导出 `buildPlayback` 同一个理由：门测死件＝B4 的病；判据必须落在生产真件上。
 *   ★ 只多一个导出，语义一字未改。
 */
export { contentSeeds };
/**
 * @param {{callTool:Function}} client
 * @param {string} key 会话 id
 * @param {string} mapText 本批次归档地图
 * @param {string[]} [seeds] 本批次归档正文的**内容线索**（`contentSeeds()` 产出，M5 首选）
 */
async function buildPlayback(client, key, mapText, seeds = []) {
    if (client === undefined || !mapText) return undefined;
    // ★★ 2026-11-09 M5（04-修复道AB故障）：查询词的**来源**必须是真的内容线索。
    //
    //   修前（B2）：`/^- .*→ .*chars @ (\S+)/` 抓的是 `@` **之后** —— 那是**层名**
    //   （constraint/finding/narrative）。真库三个 chunk 实测提取结果：
    //     ["constraint","constraint"] / ["finding","finding"] / []
    //   ⇒ 拿层名当检索词，RRF 召回与"刚才丢了什么"零相关，第三例直接整批丢回放且不报错。
    //
    //   修后两级来源：
    //     ① **首选 seeds**：本批次归档事件里字符数最大的两条，取正文首段（那才是"刚才丢了什么"）；
    //     ② 回退地图行**标题段**（去掉 `- `、`## `、`[层标签]`、`(seq N)`）。
    //   实测：地图行 head 剥完只剩「用户」「tool」—— 那是事件**种类**，不是内容，
    //   所以真正有检索价值的是 ①；② 只在没有 seeds 时兜底（例如门用固定地图做用例）。
    const queries = [];
    for (const seed of seeds) {
        // 截断在**入参侧**也做一遍（不只依赖 contentSeeds）：查询词是 FTS 的 token 串，
        // 灌进整篇正文只会污染召回，也让 op:recall 的窗口化白做。
        const q = String(seed ?? '').replace(/\s+/g, ' ').trim().slice(0, SEED_MAX_CHARS);
        if (q.length === 0) continue;
        queries.push(q);
        if (queries.length >= 2) break;
    }
    if (queries.length === 0) {
        for (const line of mapText.split('\n')) {
            const m = /^- (.+?)\s+→\s+\d+\s+chars\s+@\s+\S+\s*$/.exec(line);
            if (m === null) continue;
            const title = m[1]
                .replace(/^##\s*/, '')
                .replace(/^\[[^\]]*\]\s*/, '')       // 去 [约束]/[结论]/[发现]
                .replace(/\(seq \d+\)\s*$/, '')      // 去 (seq 11)
                .trim();
            if (title.length === 0) continue;
            queries.push(title);
            if (queries.length >= 2) break;
        }
    }
    if (queries.length === 0) return undefined;
    // ★★ 2026-11-11 批次1（05-R10／P-23 10a 报警条件）：两条 seed 去重后若塌成 1 条，
    //   本身就是选材失效信号（终稿 §6.3 第 10a：「去重后 queries 塌成 1 条须报警」）。
    //   这里**不静默**：计数进 playbackState().seedCollapse，门判据与 op:stats 都读得到。
    const dedupedQueries = [...new Set(queries)];
    if (dedupedQueries.length < queries.length) playbackStats.seedCollapse += 1;
    let recalled;
    try {
        recalled = await client.callTool('ctx', {
            op: 'recall',
            queries: dedupedQueries,
            source: `session/${key}/`,
            limit: 2,
        }, new AbortController().signal);
    }
    catch { return undefined; }
    const text = recalled?.content?.[0]?.text;
    if (typeof text !== 'string' || text.trim().length === 0) return undefined;
    // ★★ 2026-11-11 批次2（P-18 简化版）：维护方裁（seq2633 完整）——
    //   「推的两块正文没用根本，那个直接去掉」
    // ⇒ 回放**不再拼 recall 正文**，只出一行指针卡。
    //   保留的部分（语义一字不动）：
    //     ① 查询照跑（queries/seedCollapse/报警计数全保留）——选材失效信号还得看得见；
    //     ② "没命中不推卡"（上面 text 判空）——不撒谎的语义不变；
    //     ③ S-6 接线本体＝"推"这个动作：实测压缩后模型 50 次 0 次主动查，
    //        所以卡必须推（seenB/playbackShown 遥测照常走 consumePlayback）。
    //   去掉正文的实证理由（L-024 §三）：正文选块在话题切换后 0 引用；
    //   且 2 KB 正文被 30 s 粘性窗捎带，窗内道 A 一命中就整块重发。
    //   指针指 `session/${key}/` 层前缀（不指 map——map 入库可能失败，broken 分支
    //   在 archive() 侧，buildPlayback 拿不到那个事实；层前缀 partial match 实测可用）。
    return `【压缩回放】本批次已归档；正文不随注，取回：ctx({op:"recall",source:"session/${key}/"})`;
}
/**
 * Install the pre-compaction archiver.
 *
 * The listener buffers every session event as it arrives and flushes the
 * buffer when compaction begins. Buffering rather than reading the transcript
 * at compaction time matters: `compaction/prune` drops the events behind the
 * summary, and it may run before an asynchronous archive reads them. A flush
 * from our own buffer cannot race that prune.
 *
 * @param ctx - plugin context carrying the session event bus.
 * @param getClient - resolves the live MCP client, or undefined when the bridge is down.
 * @param options - enablement and size guard.
 * @returns the exact disposer that removes the listener.
 */
export function installPrecompactArchive(ctx, getClient, options = {}) {
    if (options.enabled === false)
        return () => { };
    const maxCharsPerLayer = options.maxCharsPerLayer ?? DEFAULT_MAX_CHARS_PER_LAYER;
    // Buffered transcript per session, plus the compaction points already filed.
    const buffers = new WeakMap();
    const archived = new Set();
    /**
     * ★★ 2026-11-09 M8（04-修复道AB故障）：**每会话一条串行链**。
     *
     *   修前 `void archive(...)`（不 await、不排队）⇒ 两次 `compaction/start` 挨得近时
     *   两份 `archive()` 并发跑：后完成的那个 `notices.set(key, {...playback})` 把先完成的
     *   整份 notice 覆盖掉 —— 先那份 playback 再也没人取得到（`consumePlayback` 只能取一次）。
     *   实测形态：`precompact.js:283` 先 `await buildPlayback`，`:287` 再整体 `notices.set`，
     *   两次归档在这两步之间交叠就必丢一份。
     *
     *   修法：同一 session 的 archive 串成 promise 链（不并发），而不是给 notices 打补丁
     *   合并字段 —— 后者是"覆盖"病根的第二份实现。
     */
    const chains = new Map();
    const enqueue = (session, buffered) => {
        const key = session;
        const prev = chains.get(key) ?? Promise.resolve();
        const next = prev
            .then(() => archive(session, buffered, getClient, maxCharsPerLayer, archived))
            .catch(() => {
                // Archiving is a best-effort passenger on the compaction path; a
                // failure here must never surface in the compaction that triggered it.
            })
            .then(() => {
                // 链尾自己清掉，防 Map 无限增长（只清自己这一节）
                if (chains.get(key) === next) chains.delete(key);
            });
        chains.set(key, next);
    };
    return ctx.on('session/event', (session, event) => {
        const key = session;
        if (event.type === 'compaction/start') {
            const buffered = buffers.get(key) ?? [];
            // Clear before the async flush: a second start event for the same
            // compaction must not file the same content twice.
            buffers.set(key, []);
            enqueue(session, buffered);
            return;
        }
        if (!CARRIES_TRANSCRIPT.has(event.type))
            return;
        const buffer = buffers.get(key);
        if (buffer === undefined) {
            buffers.set(key, [event]);
            return;
        }
        buffer.push(event);
        // Bound the buffer so a session that never compacts cannot grow forever.
        if (buffer.length > MAX_BUFFERED_EVENTS)
            buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    });
}
/** Classify the buffered transcript and file each layer into the knowledge base. */
async function archive(session, buffered, getClient, maxCharsPerLayer, archived) {
    const client = getClient();
    if (client === undefined)
        return;
    const key = sessionId(session);
    const stamp = `${key}:${session.seq ?? buffered.length}`;
    if (archived.has(stamp))
        return;
    archived.add(stamp);
    // local.7: merge the buffered tail with the live transcript instead of
    // choosing one. The snapshot is read synchronously here — before
    // `compaction/prune` can drop the events — so a plugin that mounted
    // mid-session still archives the history this compaction is about to prune
    // (local.6 archived only its own buffer and silently lost that history).
    // Events already filed by an earlier flush are skipped by seq, so repeated
    // compactions add only what is new.
    const flushed = archivedSeqs.get(session) ?? new Set();
    archivedSeqs.set(session, flushed);
    const events = [];
    for (const event of [...session.snapshotEvents(), ...buffered]) {
        const eventSeq = typeof event.seq === 'number' ? event.seq : undefined;
        if (eventSeq !== undefined) {
            if (flushed.has(eventSeq))
                continue;
            flushed.add(eventSeq);
        }
        events.push(event);
    }
    if (events.length === 0)
        return;
    const lines = classify(events);
    if (lines.length === 0)
        return;
    // local.8: file every layer as one or more parts rather than stopping at the
    // first part's budget. `filed` is the only authority the map and the notice
    // may speak from; `dropped` is what even the part ceiling could not hold.
    const { parts, filed, dropped } = chunkLayers(key, lines, maxCharsPerLayer);
    // local.9: a failed ctx(op:'index') call must not be counted as filed and must
    // not abort the remaining parts — file what can be filed, then state the loss.
    let failed = 0;
    const broken = [];
    for (const part of parts) {
        if (part.text.length === 0)
            continue;
        try {
            // ★ 2026-11-04 P4 两条改动（最终定义 §2.2 + 06 报告 §三.7）：
            //   ① **不再 segmentCjk** —— 写入侧的汉字分词是**库内职责**
            //      （06-gram 的 buildScriptNgrams 内部 deSpaceHan 折叠汉字间空白），
            //      调用方再铺一遍 = 同一件事两份实现，且铺过的正文在 trigram 表里
            //      存的是隔字形态 → trigram 榜对中文 0 命中（实测「结论」→ 0 块）。
            //   ② **传 attribution.sessionId** —— 没有它，chunks.session_id 恒空
            //      → tier boost（当前会话块优先，Q-3）判据永远不成立 → 恒 0。
            await client.callTool('ctx', {
                op: 'index',
                content: render(part.text),
                source: part.label,
                sessionId: key,
            }, new AbortController().signal);
        }
        catch {
            failed += part.indices.length;
            broken.push(part.label);
            for (const index of part.indices)
                filed.delete(index);
        }
    }
    // local.6: file the per-compaction map — the event-by-event inventory of
    // what was archived and where — under its own source, then record the
    // synchronous notice the prompt-injection section reads back. The map
    // exists so a post-compaction model does not merely *have* an archive but
    // is *told*, every request, that this session's pruned history is
    // retrievable and how to address it.
    const map = buildMap(key, lines, filed, dropped, maxCharsPerLayer, failed);
    let mapSource;
    try {
        mapSource = `session/${key}/map`;
        await client.callTool('ctx', {
            op: 'index',
            content: map,
            source: mapSource,
            sessionId: key,
        }, new AbortController().signal);
    }
    catch {
        mapSource = undefined;
        broken.push('map');
    }
    // ★ 2026-11-04 P5：**道 B 接线**（S-6）。
    //
    // 为什么必须要：实测压缩后模型 **50 次里 0 次**会主动去查自己丢了什么
    // （01-立项书 §十二）→ 不推就永远不查。1.0.0 的 `10-recall.recallCompacted`
    // 写好了却**零调用方**（15-hooks 没人调）→ seenB 恒 0。
    //
    // 这里不重新实现选择逻辑（那在引擎 10-recall 里）；只做两件事：
    //   ① 通过 `op:"recall"` 取一次"压缩后最该回放的内容"（引擎侧三榜 + 窗口化）
    //   ② 把结果缓存进 `playback` Map，供 `consumePlayback(sessionId)` 一次性取用
    //      （由 session-memory 的 prompt 注入段读 —— 一个批次只推一次）
    let playback;
    try {
        playback = await buildPlayback(client, key, map, contentSeeds(lines, filed));
    }
    catch { playback = undefined; }
    if (playback !== undefined) {
        playbackStats.built += 1;
        playbackSeen.add(`${key}::${seqRange(lines.filter((_line, index) => filed.has(index)))}`);
    }

    // ★★ 2026-11-11 批次1（05-R11 乙案／A 案）：**L1 流程链在此算好、存进 notice**。
    //   时机＝压缩时（不是每渲染现算）——这一步 events 已在手（`:360` 那次拼接），
    //   `humanRings` 只是它的真人子集，零额外读口（R-8b 已证：不新增 snapshotEvents/eventAt）。
    //   渲染侧（session-memory 的 archivePointer）只读这一份，两次 flush 之间完整节稳定，
    //   避开 `session-memory.js:100–106` 那条"每事件行重渲 ⇒ 68 轮 660 KB 重复快照"的旧事故。
    const flowChain = buildFlowChain(humanRings(events));
    // ★ 常驻体＝L1+L6+L2+L3+L4+L5+card 全量 1,406 B（典型）／1,758 B（上界）。
    //   card 用本轮 mapSource 指针（首个已归档事件坐标），不带 seq（P-9 定稿）。
    const resident = renderResident(events, {
        card: mapSource
            ? `[archive] 完整正文：ctx({op:"recall", source: "${mapSource}"})`
            : `[archive] 本轮地图未入库，按层 source 检索：${[...new Set(parts.map((p) => p.layerLabel))].join(' / ')}`,
    });

    notices.set(key, {
        count: (notices.get(key)?.count ?? 0) + 1,
        seqs: seqRange(lines.filter((_line, index) => filed.has(index))),
        mapSource,
        layers: [...new Set(parts.filter((part) => !broken.includes(part.label)).map((part) => part.layerLabel))],
        filed: filed.size,
        seen: lines.length,
        dropped,
        failed,
        // ★ P5：道 B 回放（≤2048 B 的 recap 卡 + 整块），供 prompt 注入段读一次
        playback,
        // ★ 批次1（R-11 乙案）：L1 有序流程链（常驻，落 archivePointer 侧，绝不进 playback）
        flowChain,
        // ★ 批次1：六层常驻体全文（session-memory 优先读这份；flowChain 留作回退）
        resident,
    });
}
/**
 * local.8: split archived lines into per-layer parts that each respect the size
 * guard, and record exactly which events made it in.
 *
 * A part is closed before a line would overflow it, so no event is ever cut
 * mid-body. `label` is the source the part is filed under (`…/finding`, then
 * `…/finding-p2`, `-p3`, …), and each line is stamped with the label that holds
 * its full text so the map can point at the right part. Once MAX_LAYER_PARTS is
 * exhausted the remaining events are counted as dropped — reported, never
 * silently discarded the way local.6/7 did.
 *
 * @param key - session id used in source labels.
 * @param lines - classified lines; each is stamped with its `.label`.
 * @param maxChars - per-part character budget.
 */
function chunkLayers(key, lines, maxChars) {
    const parts = [];
    const filed = new Set();
    const open = new Map();
    const used = new Map();
    let dropped = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const layerLabel = `session/${key}/${line.layer}`;
        let current = open.get(line.layer);
        if (current !== undefined && current.text.length + line.text.length + 2 > maxChars) {
            current = undefined;
            open.delete(line.layer);
        }
        if (current === undefined) {
            const partsUsed = used.get(line.layer) ?? 0;
            if (partsUsed >= MAX_LAYER_PARTS) {
                dropped += 1;
                continue;
            }
            current = { layerLabel, label: partsUsed === 0 ? layerLabel : `${layerLabel}-p${partsUsed + 1}`, text: '', indices: [] };
            used.set(line.layer, partsUsed + 1);
            parts.push(current);
            open.set(line.layer, current);
        }
        current.text = current.text.length === 0 ? line.text : `${current.text}\n\n${line.text}`;
        line.layerLabel = layerLabel;
        line.label = current.label;
        filed.add(index);
        current.indices.push(index);
    }
    return { parts, filed, dropped };
}
/**
 * local.6: the seq span an archive covered, as a human-readable range.
 * @param lines - classified archive lines (headings carry the seq).
 */
function seqRange(lines) {
    let first = Infinity;
    let last = -Infinity;
    for (const line of lines) {
        const m = /\(seq (\d+)\)/.exec(line.text.slice(0, 80));
        if (m === null)
            continue;
        const seq = Number(m[1]);
        if (seq < first)
            first = seq;
        if (seq > last)
            last = seq;
    }
    if (last === -Infinity)
        return '?';
    return first === last ? `seq ${first}` : `seq ${first}-${last}`;
}

// ─────────────────────────────────────────────────────────
// ★★ 2026-11-11 批次1（05-R11 乙案）：L1 流程链渲染器（A 案＝压缩时算）
// ─────────────────────────────────────────────────────────

/**
 * 从 events 里挑"真人环"（§6.1：环＝真人消息，且**排除**【来信】）。
 *   · 判据用 `data.source.kind === 'user'` —— ★真路径是 `data.source.kind`，
 *     event 顶层与 `data` 均无 `kind`（§6.3 第 10b ① 写死）。
 *   · `/^【来信】/` 必须剥：实测 14 条【来信】的 kind 也是 `user`，
 *     来信重复度 86%，白烧 336 B（§6.1 表 L1 行），此道不可省。
 * @param {Array} events
 * @returns {Array<{seq:number, text:string}>} 按 seq 升序
 */
export function humanRings(events) {
    const rings = [];
    for (const event of events) {
        if (event?.type !== 'user/message') continue;
        const d = event.data ?? {};
        if (d?.source?.kind !== 'user') continue;
        const blocks = Array.isArray(d.content) ? d.content : [];
        const parts = [];
        for (const b of blocks) {
            if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
        const flat = parts.join('\n').trim();
        if (flat.length === 0) continue;
        if (/^【来信】/.test(flat)) continue;   // ★ 来信不算环（重复度 86%）
        if (typeof event.seq !== 'number') continue;
        rings.push({ seq: event.seq, text: flat });
    }
    rings.sort((a, b) => a.seq - b.seq);
    return rings;
}

/** 单环整条 ≤CHAIN_NEAR_RING_MAX_BYTES；超了走"首12字符+…+末12字符"（§6.1）。
 *  ★ 必须带 `⟨seq⟩` 指针：7b A1「每部件必带指针（禁裸摘要）」，靶子正则 `⟨(\d+)(?:-(\d+))?⟩`
 *    单点形态也合法（`-(\d+)?` 可选）。参照件 `Temp\04daoab\v3.mjs:25` 渲的就是 `⟨seq⟩…`。 */
function renderNearRing(ring) {
    const one = ring.text.replace(/\s+/g, ' ').trim();
    if (Buffer.byteLength(one, 'utf8') <= CHAIN_NEAR_RING_MAX_BYTES) return `⟨${ring.seq}⟩${one}`;
    return `⟨${ring.seq}⟩${one.slice(0, CHAIN_NEAR_EDGE_CHARS)}…${one.slice(-CHAIN_NEAR_EDGE_CHARS)}`;
}

/**
 * 渲 L1 两级链（§6.1）：近端 K 环整条 ＋ 远端 3 并 1 递归至 ME=6，
 * 远端段形态 `⟨a-b⟩`＋8 字主旨。
 *
 * ★ 形状严格对齐一手参照件 `Temp\04daoab\v3.mjs` 的 `render()`：
 *   部件一律 `⟨…⟩…`、连接符一律 `→`（check 侧 split('→')）。
 *   修前本窗第一版把近端渲成 `seq 文本`（无 ⟨⟩），7b A1 直接违例——
 *   这就是 §6.3 反复警告的"错的判据不会报错，它在真闸失效时抢着报绿"的反面：
 *   此处是"对的参照件"抓到"刚写的实现"走形，当场纠。
 *
 * ★ 判据 8（§6.3）「链长对环数**不单调**」是**实测事实**，不是 bug：
 *   并段落点取决于初始早段数 **模 3**（合成实测 22 环 461 B → 25 环 344 B）。
 *   ⇒ 容量规划一律走 §6.2 上界公式（`ME×41 + K×109 + 分隔`），**禁止**用
 *   "环数变多所以链变长"做断言。本函数因此**不承诺单调**，只承诺**不超上界**。
 *
 * @param {Array<{seq:number,text:string}>} rings
 * @returns {string}
 */
export function buildFlowChain(rings) {
    if (!Array.isArray(rings) || rings.length === 0) return '';
    const cut = Math.max(0, rings.length - CHAIN_NEAR_K);
    // 远端 = cut 之前的早段，先按单点成段，再 3 并 1 递归至 ≤ME
    let segments = rings.slice(0, cut).map((r) => ({ a: r.seq, b: r.seq, topic: r.text.replace(/\s+/g, ' ').trim() }));
    while (segments.length > CHAIN_MERGE_MAX) {
        const merged = [];
        for (let i = 0; i < segments.length; i += CHAIN_MERGE_RATIO) {
            const grp = segments.slice(i, i + CHAIN_MERGE_RATIO);
            merged.push({ a: grp[0].a, b: grp[grp.length - 1].b, topic: grp[0].topic });
        }
        segments = merged;
    }
    const near = rings.slice(cut);
    const parts = [];
    for (const s of segments) parts.push(`⟨${s.a}-${s.b}⟩${s.topic.slice(0, CHAIN_MERGE_TOPIC_CHARS)}`);
    for (const r of near) parts.push(renderNearRing(r));
    // ★ ⑳ 层内自封顶：933 B 由结构参数（K=6×~109 + ME=6×41 + 分隔）推得，但"推得"不等于"保证"——
    //   真人消息可能一条就是 100 B 整条形态、主旨也可能撞满，实测极值 867 B 已接近。
    //   出口一律裁到 CHAIN_MAX_BYTES，裁时**从最远端段丢起**（保近端＝保"刚才丢了什么"，
    //   也保 `⟨⟩` 指针完整，绝不字节劈半截指针）。
    let chain = parts.join('→');
    while (Buffer.byteLength(chain, 'utf8') > CHAIN_MAX_BYTES && parts.length > 1) {
        parts.shift();          // 丢最远的一个部件（远端段先丢，再丢近端最早的）
        chain = parts.join('→');
    }
    return chain;
}

/**
 * local.6: build the per-compaction archive map.
 *
 * One line per archived event: kind, seq, size, and the exact source that holds
 * the full text — the inventory a post-compaction model queries first, so a
 * detail the summary dropped is addressed by coordinates rather than guessed at.
 *
 * local.8: rows are built from the events that were actually filed, and each
 * row names its part (`…/finding` vs `…/finding-p2`), so following the map can
 * no longer lead to a source that does not contain the text. Whatever the part
 * ceiling could not hold is stated on its own line instead of being implied.
 *
 * @param key - session id used in source labels.
 * @param lines - the classified lines, each stamped with `.label` when filed.
 * @param filed - indexes into `lines` that were actually written.
 * @param dropped - events the per-layer part ceiling could not hold.
 * @param maxChars - per-part character budget that produced `dropped`.
 */
function buildMap(key, lines, filed, dropped, maxChars, failed = 0) {
    const prefix = `session/${key}/`;
    const rows = [];
    const layerLabels = [];
    let unlisted = 0;
    const header = `## Archive Map (session ${key})

本次压缩已入库以下事件原文。行尾 @ 后为层名：完整 source 是 \`${prefix}<层名>\`，也可只传层名（部分匹配即可），例如 ctx({op:"recall", queries:["…"], source:"finding-p3"})。

`;
    const tailOf = () => `

（行尾 @ 后为层名，可直接作为 source 使用，支持部分匹配）
层入口：${layerLabels.join(' / ')}`;
    const notes = () => {
        const out = [];
        if (unlisted > 0)
            out.push(`- …(其余 ${unlisted} 条未列出，正文仍可检索，按层 source 过滤即可)`);
        if (failed > 0)
            out.push(`- ⚠ ${failed} 条写入失败（ctx op:"index" 报错），未入库，需重试`);
        if (dropped > 0)
            out.push(`- ⚠ ${dropped} 条超出 ${MAX_LAYER_PARTS}×${maxChars} 字符预算，本次未入库`);
        return out;
    };
    let used = header.length + 900;
    for (let index = 0; index < lines.length; index += 1) {
        if (!filed.has(index))
            continue;
        const line = lines[index];
        const head = line.text.slice(0, line.text.indexOf('\n') === -1 ? line.text.length : line.text.indexOf('\n'));
        const bodyChars = line.text.length - head.length;
        if (!layerLabels.includes(line.layerLabel))
            layerLabels.push(line.layerLabel);
        const suffix = line.label.startsWith(prefix) ? line.label.slice(prefix.length) : line.label;
        const row = `- ${head} → ${bodyChars} chars @ ${suffix}`;
        if (rows.length >= MAX_MAP_ROWS || used + row.length + 1 > MAX_MAP_CHARS) {
            unlisted += 1;
            continue;
        }
        used += row.length + 1;
        rows.push(row);
    }
    const body = `${header}${rows.join('\n')}${notes().length > 0 ? `\n${notes().join('\n')}` : ''}${tailOf()}`;
    if (body.length <= MAX_MAP_CHARS)
        return body;
    const cut = body.slice(0, MAX_MAP_CHARS);
    const safe = cut.slice(0, Math.max(0, cut.lastIndexOf('\n')));
    return `${safe}\n- …(输出超出 ${MAX_MAP_CHARS} 字符上限，其余行已截断；正文仍可检索)`;
}
/**
 * Assign every transcript event to a layer.
 *
 * Classification is by event kind, not by importance scoring: a user message
 * is a constraint because of who produced it, and a tool result is a finding
 * for the same reason. Assistant prose is narrative unless it states a
 * concrete value, which is promoted to `finding` so conclusions the assistant
 * reached are searchable beside the evidence.
 */
export function classify(events) {
    const lines = [];
    // ★★ 2026-11-11 批次1 前置 bug(a)（04 主持实测坐实、本窗用一手会话复算）：
    //   `tool/result` 事件的 data **没有 name**（实测 303/303 全无），真名只存在于**同一次调用的
    //   `tool/call` 事件**里，两边用 `callId` 咬合（实测 `data.callId === data.message.callId ===
    //   data.message.toolCallId`，且 callId 100% 可对到 tool/call）。
    //   ⇒ 修前 `heading()` 的 `data?.name` 恒 undefined ⇒ **每条结论行都退化成 `## [结论] tool`**，
    //     模型看完不知道"是谁返回的"，7,338/34,913＝21.0% 的归档标题受害（一席 58.8% 为口径差，
    //     数字由主持订正）。修法：先扫一遍建 callId→name 映射，再交给 heading 查。
    const callNames = new Map();
    for (const event of events) {
        if (event?.type !== 'tool/call') continue;
        const d = asRecord(event.data);
        const cid = typeof d?.callId === 'string' ? d.callId : undefined;
        const nm = typeof d?.name === 'string' ? d.name : undefined;
        if (cid !== undefined && nm !== undefined) callNames.set(cid, nm);
    }
    for (const event of events) {
        const text = textOf(event);
        if (text.length === 0)
            continue;
        if (isInjectedContext(text))
            continue;
        const layer = layerOf(event.type, text);
        if (layer === undefined)
            continue;
        lines.push({ layer, text: `${heading(event, layer, callNames)}\n${text}` });
    }
    return lines;
}
/**
 * Whether a message body is harness-injected context rather than transcript.
 *
 * DSH attaches `<current_runtime_context>`, `<active_memory>`,
 * `<system-reminder>`, and `<resume_snapshot>` blocks to user messages, so
 * they arrive with the same `user/message` type as a genuine user turn. They
 * are per-turn runtime noise, not requirements or decisions: filing them under
 * `constraint` both dilutes that layer and returns stale policy snapshots for
 * policy-shaped queries. `<active_memory>` is also a second-hand summary of
 * events that are archived directly, so keeping it would store the same facts
 * twice.
 *
 * The check has to cover two shapes. The tag form is what the model sees when
 * a block is inlined whole, but `textOf` reads only the text blocks of a
 * message, so a block's opening tag can be stripped before this point and the
 * body then begins with the injected block's own heading — the transcripts
 * this was written against start with "Current runtime context." rather than
 * with a tag. Matching the headings as well keeps those from being filed.
 *
 * A body qualifies only when an injected marker *starts* the message, so a
 * user who quotes one of these tags mid-sentence is still archived.
 */
export function isInjectedContext(text) {
    return INJECTED_CONTEXT_PATTERN.test(text);
}
const INJECTED_CONTEXT_PATTERN = new RegExp('^\\s*(?:' +
    '<(?:current_runtime_context|active_memory|system-reminder|resume_snapshot)\\b' +
    '|Current runtime context\\b' +
    '|The available skill catalog changed\\b' +
    ')');
/** Return the layer for one event, or undefined when it carries no transcript value. */
function layerOf(type, text) {
    if (type === 'user/message')
        return LAYERS.constraint;
    if (type === 'tool/result')
        return LAYERS.finding;
    if (type === 'assistant/message') {
        return statesAConcreteValue(text) ? LAYERS.finding : LAYERS.narrative;
    }
    return undefined;
}
/**
 * Whether assistant prose states a value worth retrieving on its own.
 *
 * The check targets the shapes that carry an answer: a number with a unit or
 * identifier, a filesystem path, an error identifier, or an explicit finding
 * verb. Prose that merely describes intended work does not qualify, which is
 * what keeps "I need to check the config" out of the findings layer.
 */
export function statesAConcreteValue(text) {
    return (/\d+\s*(ms|s|m|h|kb|mb|gb|%|个|次|行|条|秒|分|小时)/i.test(text) ||
        /\b[A-Za-z]:[\\/]|\/(?:Users|home|var|etc|opt|tmp)\//.test(text) ||
        /\b[A-Z]{2,}[_-]\d+\b|\b[a-z]+(?:[A-Z][a-z]+)+\b/.test(text) ||
        /(根因|原因是|结果是|结论是|发现|定位到|确认了|实际上|真实值|上限为|下限为|等于|超过)/.test(text));
}
/** Build the model-facing heading that names the event and its layer. */
function heading(event, layer, callNames) {
    const data = asRecord(event.data);
    if (layer === LAYERS.constraint)
        return `## [约束] 用户 (seq ${event.seq ?? '?'})`;
    if (event.type === 'tool/result') {
        // ★★ 2026-11-11 批次1 前置 bug(a) 修正（一手实测：真机 303/303 tool/result 的 `data.name` 不存在；
        //   `isError` 也不在 `data` 上，而在 `data.message.isError`——修前 `data?.isError === true`
        //   **恒 false** ⇒ "(失败)" 这个标记一次都没出现过，失败结论与成功结论在归档里长得一模一样）。
        //   取名次序：callId → callNames（由 classify 从同会话 tool/call 建好）→ 兜底旧形态 `data.name` → 'tool'。
        //   ★ 兜底必须留着：历史归档件（终稿 §三之二）里存在 `data.name` 直接有值的旧形态。
        const message = asRecord(data?.message);
        const cid = typeof message?.callId === 'string' ? message.callId
            : typeof message?.toolCallId === 'string' ? message.toolCallId
                : typeof data?.callId === 'string' ? data.callId : undefined;
        const byId = cid !== undefined ? callNames?.get(cid) : undefined;
        const name = byId ?? (typeof data?.name === 'string' ? data.name : 'tool');
        const failed = (message?.isError === true || data?.isError === true) ? ' (失败)' : '';
        return `## [结论] ${name}${failed} (seq ${event.seq ?? '?'})`;
    }
    return `## [发现] 助手 (seq ${event.seq ?? '?'})`;
}
/** Extract the plain text of one event, ignoring reasoning and non-text blocks. */
export function textOf(event) {
    const data = asRecord(event.data);
    if (data === undefined)
        return '';
    if (event.type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : '';
        const args = typeof data.arguments === 'string' ? data.arguments : '';
        return name.length === 0 ? '' : `调用 ${name} ${clip(args, 240)}`.trim();
    }
    const message = asRecord(data.message) ?? data;
    const content = message.content;
    if (typeof content === 'string')
        return clip(content, 4_000);
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        // Reasoning is the model's scratch space, not a transcript fact.
        if (record.type !== 'text' || typeof record.text !== 'string')
            continue;
        parts.push(record.text);
    }
    return clip(parts.join('\n'), 4_000);
}
/** Stable session identity used in the source label. */
function sessionId(session) {
    if (typeof session.id === 'string' && session.id.length > 0)
        return session.id;
    const events = session.snapshotEvents();
    const first = events[0]?.seq ?? 0;
    const last = events.at(-1)?.seq ?? 0;
    return `seq${first}-${last}`;
}
/** Render one layer body with a retrieval hint the model can act on. */
export function render(text) {
    return text;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function clip(value, max) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
