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
import { archiveNotice, consumePlayback } from './precompact.js';
import { existsSync } from 'node:fs';

/**
 * ★★ 2026-11-10 推送总开关（维护方决定：「自动推送已经达成，先暂时关掉」）。
 *
 * 干什么：让【压缩回放】（道 B）**不再进模型上下文**。
 * ★★ 2026-11-14（项目 07）修订：维护方决定「把道A去掉，不要道A推送了」——
 *   道 A【旧经验提醒】的整条链已摘除（件 `recall-hints.js` 已删、`hintConsumer` 已删），
 *   于是本开关现在**只管道 B 一家**。开关文件路径与语义一字未改。
 *
 * 为什么只有这一处：道 B 的**唯一出口**就是本文件 `buildMemory` 里那次取用
 * （`consumePlayback`）。归档写库、`[archive]` 指针、`resume_snapshot`
 * 导航都不经过它 —— 所以"关推送"与"归档照写"天然不冲突，不需要动 precompact 一行。
 *
 * 怎么开/关：**存在这个文件就是关，删掉就是开**。不重启 DSH —— 本函数每次渲染上下文
 * 都会调用，`existsSync` 一次即可（一个请求两次渲染 = 两次 stat，代价可忽略）。
 *
 * 开关文件：`<插件数据根>\push-off`（数据根由装配层注入，跟着安装位置走）
 *   ★ 用"文件存在性"而不是读 JSON：少一次解析、少一种坏文件形态，
 *     而且忘了里面写什么也不会误判。
 *   ★ 路径由装配层 `setPushOffPath(join(storageDir,'push-off'))` 注入 ——
 *     本文件不猜数据根（猜错 = 开关按了没反应，而用户以为关上了）。
 */
let pushOffPath = undefined;

/** ★ 装配层注入开关文件路径（platform/plugin.js 用 storageDir 算出来）。 */
export function setPushOffPath(p) {
    pushOffPath = typeof p === 'string' && p.length > 0 ? p : undefined;
}

/** 推送是否被关掉。任何异常都当作"没关"（推送失败绝不阻断 prompt 组装）。 */
function pushOff() {
    if (pushOffPath === undefined) return false;   // 没注入 = 没有开关 = 保持原行为
    try {
        return existsSync(pushOffPath);
    }
    catch {
        return false;
    }
}

/**
 * ~~道 A 的出口 —— 由 `platform/plugin.js` 注入取用函数~~
 *
 * ★★ 2026-11-14（项目 07）：**整段删除**（`setHintConsumer` / `hintConsumer` 两件）。
 *   原代码留档（07-BACKUP\overlay\ours\session-memory.js:41-49）：
 *     let hintConsumer = () => undefined;
 *     export function setHintConsumer(fn) {
 *         if (typeof fn === 'function') hintConsumer = fn;
 *     }
 *   为什么删而不留空函数：留一个"注入了也永远没人取"的口，下一个人会以为道 A 还在，
 *   去找一个不存在的推送源。**摘干净比留个壳诚实。**
 */
const CONTEXT_NAME = 'dsh-eco-context:active-memory';
/**
 * ★★★ 2026-11-09 M9（04-修复道AB故障）：**一次性内容的粘性窗口**（毫秒）。
 *
 *   宿主在**同一个请求**里会对本上下文求值**两次**：
 *     · `dsh-agent-loop:679` preStep → `systemPrompt.assemble()` → provider.text()
 *     · `dsh-agent-loop:843` step    → `systemPrompt.refreshContext()` → provider.text()
 *   而 `dsh-agent-loop:859-866` 提交给模型的是**第 2 次**那份
 *   （第 1 次那份在 `firstAttempt` 分支里被丢弃）。
 *
 *   道 B 的出口是"**取走即清**"（一次内容只带一个请求）。
 *   于是第 1 次渲染就把内容拿走了 ⇒ 第 2 次渲染拿到空
 *   ⇒ **内容从未进过模型上下文**，而 seen/遥测已经把它算成"推过"。
 *   真机实测（723 个会话 / 1350 条 runtime-context 快照）：
 *   含【旧经验提醒】= **0**，含【压缩回放】= **0**；
 *   含 `active_memory` 的 40 条里只有归档指针与导航 —— 那两者是两次渲染之间
 *   **内容稳定**的部分，所以留得住；一次性内容全灭。
 *   ★ 2026-11-14 项目 07：道 A 已摘除，上面那句"含【旧经验提醒】=0"现在成了
 *     **历史实测记录**（当年它的确一次都没送出去过）。粘性窗口对道 B 仍然必要。
 *
 *   修法：注入层记住"这一轮取到过什么"，在窗口内**再渲染一次时给同一份**。
 *   窗口按**时间**计（不是调用次数），因为两次渲染之间隔着一整个 step 的准备。
 *   取 30 秒：够覆盖一次请求的两次渲染 + 一次重试；又短到下一轮不会继续带着
 *   上一条内容（1.0.2 的教训：每轮重发 = 每轮重烧上下文）。
 */
const STICKY_MS = 30_000;
/** Register dynamic active-memory context over DSH's durable Session log. */
export function installSessionMemory(ctx) {
    const prompt = ctx.get('systemPrompt', false);
    if (prompt === undefined)
        return () => { };
    const states = new WeakMap();
    // ★ 2026-11-09 M9：粘性记录**单独一张表**，不与 stamp 缓存混在一张。
    //   理由：stamp 缓存每次渲染都会被整体覆盖（`states.set(session, {stamp, rendered})`），
    //   粘性记录必须活过那次覆盖 —— 混在一起会被顺手抹掉。
    const stickies = new WeakMap();
    return prompt.context({
        name: CONTEXT_NAME,
        order: prompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
        text: rawContext => {
            const context = rawContext;
            return buildMemory(context.agent ?? context.scope, states, stickies);
        },
    });
}
/**
 * Build the archive pointer for one session.
 *
 * 1.0.2: this context carries ONLY the pointer. It used to append the last 50
 * event lines as well — `user: …`, `tool call: …`, `tool result: …` — which
 * changed on every step. DSH joins every dynamic context into one runtime-context
 * snapshot and re-appends that snapshot whenever the joined text differs from the
 * retained one, so a per-event line here forced the whole snapshot (working
 * directory, file policy, approval policy, GUI URL, this pointer) back into the
 * model context on nearly every step: 251 of 254 consecutive snapshot changes in
 * one session came from this context, ~660 KB of duplicated snapshots over 68
 * turns. Those event lines only repeated the conversation the model already
 * holds, while the pointer is correct to change only when a flush happens.
 * Render from the notice alone and keep the result byte-identical between flushes.
 */
function buildMemory(scope, states, stickies) {
    const session = sessionFromScope(scope);
    if (session === undefined)
        return '';
    const notice = archiveNotice(session.id);
    const events = session.snapshotEvents();
    const summary = events.findLast(event => event.type === 'compaction/summary');
    const navigation = summary === undefined ? undefined : navigationText(session, summary);
    const pointer = notice === undefined ? undefined : archivePointer(notice);
    // ★ 2026-11-04 P5（道 B）：压缩后**推一次**回放（取走即清，不会每轮重复）。
    //   这一段是 1.0.0 缺失的那条 —— `10-recall.recallCompacted` 写好了却零调用方，
    //   实测 `seenB` 恒 0（06 报告 §三.6）。道 B 失败不影响其余注入（静默）。
    //
    // ★★★ 2026-11-09 M9：一次性内容必须**粘住**，否则宿主第二次渲染拿不到。
    //   出口本身仍是"取走即清"（池的语义不动），**粘性做在这一层**：
    //   本层记住"这一轮取到过什么"，窗口内再渲染时**并排**给出。
    //
    //   ★ 为什么是"并排"而不是"二选一"：
    //   宿主同一次请求里两次渲染之间，池里可能又来了新内容（pre-execute 又评估了一次）。
    //   若第二次渲染只给新的那份，上一次取到的那份就**永远送不出去**（它已被标记 seen）。
    //   所以：**粘住的那份 + 新取到的那份，一起进 body** —— 宁可多带一条，
    //   不可少送一条（少送 = 永久丢失 + 永久除名）。
    const sticky = stickyOf(session, stickies);
    // ★★ 2026-11-10 推送总开关：关着就**不取、也不带粘性窗口里那份**。
    //   粘性那份必须一起压住 —— 否则关掉后 30 s 内还会把上一轮攥着的推出去，
    //   看起来就像"开关不管用"。
    //   ★ 关着时**不清队列、不清 notices**：那两份没送出去也不算推过，
    //     开回来还能送（关一下不许烧掉已排队的经验）。
    //
    // ★★ 2026-11-14（项目 07）修订：道 A 摘除后，这里只剩**道 B 一条**。
    //   删掉的是：`freshHint` 取用、`hint` 合成、粘性里的 `hint` 位、stamp 里的 `a:` 位。
    //   原代码留档（07-BACKUP\overlay\ours\session-memory.js:141-158）：
    //     let freshHint;
    //     if (!off) { try { freshHint = hintConsumer(session.id); } catch { freshHint = undefined; } }
    //     const hint = off ? undefined : joinParts(sticky?.hint, freshHint);
    //     if (!off && (freshHint !== undefined || freshPlayback !== undefined)) {
    //         setSticky(session, stickies, { hint: freshHint ?? sticky?.hint, playback: freshPlayback ?? sticky?.playback });
    //     }
    const off = pushOff();
    let freshPlayback;
    if (!off) {
        try { freshPlayback = consumePlayback(session.id); } catch { freshPlayback = undefined; }
    }
    const playback = off ? undefined : joinParts(sticky?.playback, freshPlayback);
    // 更新粘性：新取到的优先（内容换了就换掉旧的那份）。
    if (!off && freshPlayback !== undefined) {
        setSticky(session, stickies, { playback: freshPlayback ?? sticky?.playback });
    }
    // ★★ 2026-11-11 批次1（05-R5／终稿 §6.3 判据 9「⑱-位置」）：数组序改
    //   `[playback, navigation, pointer]` ⇒ **playback 为注入体首个非空部件**。
    //   改前核调用方是否依赖 body 顺序（判据 9 明文要求）：本件里 body 只被
    //   `wrap(body)` 整体包进 `<active_memory>`（无分段长度预算、无前缀匹配），
    //   `stamp` 取的是各 part 的**内容指纹**不是下标（M9），⇒ 重排不影响任何既有语义。
    //   为什么位置要进门：回放是"刚丢的东西"，排最后容易被后面长文本挤到模型注意力之外。
    //   ★ 2026-11-14 项目 07：原数组末位是 `hint`（道 A），摘除后只剩三个部件。
    const body = [playback, navigation, pointer].filter(part => part !== undefined).join('\n');
    if (body.length === 0)
        return '';
    const stamp = [
        summary?.seq ?? -1,
        notice?.count ?? -1,
        notice?.filed ?? -1,
        notice?.seen ?? -1,
        notice?.failed ?? 0,
        notice?.dropped ?? 0,
        notice?.mapSource ?? '-',
        // ★★★ 2026-11-09 M9（04-修复道AB故障）：回放的 stamp 位
        //   **必须带内容身份**，不能只带"有没有"的标志位。
        //
        //   修前是 `playback === undefined ? '-' : 'pb'` / `hint === undefined ? '-' : 'a'` ——
        //   只记"这一轮有没有"。于是**两条不同的提示**算出的 stamp 完全相同
        //   （稳定字段全同 + 都是 'a'）⇒ 命中 `states` 缓存 ⇒ `return cached.rendered`
        //   ⇒ 返回**上一条**的旧文本，新的那条被缓存挡掉、永远送不出去。
        //   实测（探针 probe-stamp-collision）：甲先到、乙后到，乙被判成"和甲同 stamp"，
        //   宿主两次渲染都拿到甲，乙永久丢失（而 seenA 已把乙算成"推过"）。
        //
        //   改成内容指纹（短哈希）：同一条内容两次渲染算出同一个指纹（缓存照常命中，
        //   省掉重复渲染），不同内容指纹不同 ⇒ 不会撞。
        //   ★ 2026-11-14 项目 07：`a:` 位随道 A 一起删除，`pb:` 位原样保留。
        playback === undefined ? '-' : `pb:${fingerprint(playback)}`,
    ].join('|');
    const cached = states.get(session);
    if (cached !== undefined && cached.stamp === stamp)
        return cached.rendered;
    const rendered = wrap(body);
    states.set(session, { stamp, rendered });
    return rendered;
}
/**
 * ★ 2026-11-09 M9：内容短指纹（stamp 用）。
 *
 * 为什么要它：stamp 原来只记"有没有提示"，导致**两条不同的提示**撞同一 stamp
 * ⇒ 命中缓存 ⇒ 新提示被上一条的旧文本挡掉（见 buildMemory 里的长注释）。
 * 指纹取内容本身 ⇒ 一条内容一个指纹，不同内容必不同，重复内容必相同。
 *
 * 不用 crypto：这里只需要"区分不同"，不需要抗碰撞。用长度 + 一个廉价滚动哈希，
 * 够把"不同的两段提示"区分开，同时保持 O(n) 与零依赖。
 */
function fingerprint(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${text.length.toString(36)}.${h.toString(36)}`;
}
/**
 * ★ 2026-11-09 M9：把"粘住的那份"与"新取到的那份"并成一段。
 *
 * 同一份内容不去重（两次取到的是同一段文本，重复拼接会变成两行一样的提示）；
 * 不同内容就都留着（宁可多带一条，也不可少送一条）。
 */
function joinParts(sticky, fresh) {
    if (sticky === undefined) return fresh;
    if (fresh === undefined) return sticky;
    if (sticky === fresh) return sticky;
    return `${sticky}\n${fresh}`;
}

/**
 * ★ 2026-11-09 M9：读本会话的粘性记录（窗口内有效，过期即视为没有）。
 *
 * 过期时顺手**清掉**，这样这张表不会一直攥着一份没人再用的旧内容。
 */
function stickyOf(session, stickies) {
    const entry = stickies.get(session);
    if (entry === undefined)
        return undefined;
    if (Date.now() - entry.at > STICKY_MS) {
        stickies.delete(session);
        return undefined;
    }
    return entry;
}
/** ★ 2026-11-09 M9：记下本轮取到的一次性内容（供同一次请求的第二次渲染复用）。 */
function setSticky(session, stickies, content) {
    stickies.set(session, { ...content, at: Date.now() });
}
function wrap(body) {
    return `<active_memory>\n${body}\n</active_memory>`;
}
function sessionFromScope(scope) {
    if (scope === null || typeof scope !== 'object')
        return undefined;
    const session = scope.session;
    return session !== undefined && typeof session.snapshotEvents === 'function' ? session : undefined;
}
/**
 * Build the pointer that tells the model a compaction happened and where the
 * archived detail lives.
 *
 * The summary body is NOT inlined. A full summary runs to tens of thousands of
 * characters, far past what this context should carry, so inlining it can only
 * ever deliver a truncated fragment with its own delimiters clipped off. The
 * archive already holds the complete text under stable `source` labels; the
 * useful thing to inject is the address, which stays small enough to never be cut.
 */
function navigationText(session, summary) {
    const id = session.id;
    if (typeof id !== 'string' || id.length === 0)
        return undefined;
    const root = `session/${id}`;
    return [
        `<resume_snapshot seq="${summary.seq}">`,
        'Compacted turns are archived; nothing is inlined here. Retrieve on demand with ctx({op:"recall"}), scoping source by:',
        `  ${root}/constraint  user requirements and decisions`,
        `  ${root}/finding     tool results and stated conclusions`,
        `  ${root}/narrative   assistant reasoning and plans`,
        'Query a concrete token (a path, a command, an error string), not a paraphrase.',
        '</resume_snapshot>',
    ].join('\n');
}
/**
 * 1.0.0: the pointer is generated from the notice, so it can state a failed write
 * or a missing inventory instead of promising a source that is not there.
 * @param notice - {@link archiveNotice} record for this session.
 */
function archivePointer(notice) {
    const notes = [];
    if (notice.dropped)
        notes.push(`${notice.dropped} more exceeded the size budget and were NOT filed`);
    if (notice.failed)
        notes.push(`${notice.failed} failed to write (op:"index" error) and are NOT retrievable`);
    const head = `[archive] compacted ${notice.count}x; ${notice.filed ?? '?'}/${notice.seen ?? '?'} pruned events (${notice.seqs}) are indexed in the context-mode knowledge base`;
    const inventory = notice.mapSource
        ? `Inventory: ctx({op:"recall", source: "${notice.mapSource}"}). Full texts: ${notice.layers.join(', ')} (partial source match works, e.g. .../narrative).`
        : `Inventory map unavailable this round; full texts: ${notice.layers.join(', ')} (partial source match works).`;
    // ★★ 2026-11-11 批次1（05-R11 乙案）：常驻体优先读 notice.resident.text（六层全文，
    //   压缩时算好＝A 案），回退到 flowChain（只有 L1），再回退到无。
    //   resident 是对象 `{text,bytes,caps,rings}`（caps 供门 ⑳ 逐层验字节上界），这里取 .text。
    //   ★ 绝不进 playback：playback 是"一次压缩推一次"的一次性消费池，
    //   常驻是本会话每一步都要带的东西——混池＝第二次压缩后链就没了（终稿 :355 写死）。
    const residentText = (notice.resident && typeof notice.resident.text === 'string') ? notice.resident.text
        : (typeof notice.flowChain === 'string' ? notice.flowChain : '');
    const chain = residentText.length > 0 ? `\n${residentText}` : '';
    return `${head}${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}. ${inventory} Do not re-run commands or re-ask the user for what the archive holds.${chain}`;
}
