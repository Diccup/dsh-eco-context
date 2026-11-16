# verify/README.md — 验收门怎么跑、判据是什么

> 用途：任何一道门都可以**一条命令重跑**，结论以退出码为准（0 = 绿，非 0 = 红）。
> 纪律：跑完落的结论段必须贴进 `docs/开发日志.md`，不许只在自己脑里过一遍。

---

## 一、七道常驻门

| 门 | 命令 | 判据 | 当前 |
|---|---|---|---|
| **G1** 骨架/入口 | `node engine/index.mjs --selftest` | 17 块就位 + **13 op** + 结构化克隆 + 真写真搜 | ✅ 全绿 |
| **全量回归** | `node engine/verify/all-blocks.mjs` | 17 块 selftest + libs + 入口，19 项 | ✅ 19/19 |
| **T 用例** | `node engine/verify/t-cases.mjs` | T-1…T-12 十二条 | ✅ 12/12 |
| **契约同形** | `node engine/verify/bridge-contract.mjs` | 平台↔引擎 13 项（工具面 1 位 `ctx`/形状/真往返/⑪-⑬ 沙箱归一反证） | ✅ 13/13 |
| **G9** 成品自检 | `node engine/verify/release-check.mjs` | 可安装版 **11 项**（在**成品目录**里验） | ✅ 11/11 |
| **G10** 真机安装链路 | `node engine/verify/install-path.mjs` | 9 项，**不注入任何接缝**（⑨ 审批流五路含真 createEscalator） | ✅ 9/9 |
| **G11** 工具面一致性 | `node engine/verify/tool-surface.mjs` | **11 项**，**真调用** + 技能文档面扫描 + 文案真源对拍 + ⑦ 模式退役负断言 + ⑩ 桥=纯翻译层 | ✅ 11/11 |
| **ISC** 装机槽自检 | `node engine/verify/install-slot-check.mjs` | 5 项：两槽清单/SHA256/启动路径 import/③b 卡片/④ patch 形状 | ✅ 5/5 |
| **拆干净机检**（2026-11-09 新增） | `node engine/verify/clean-split-check.mjs [--dir <包根>]` | §三-23：FP 的件零存在 + 活代码零 import + 文档面零教学 | ✅ 5/5 |
| **op 抽真调用**（2026-11-09 新增） | `node engine/verify/op-probe.mjs [--pkg <包根>]` | §四-2：**13 op 各真调一发** + 反向判据（search 必须调不通） | ✅ 13/13 |

> **2026-11-09 ④步 CTX 净身**（op:search 整条迁 FP）后的门数变化，如实记：
> G9 12 → **11 项**（⑫ R1 冻结导出面退役，§三-10）；
> G11 13 → **11 项**（④/④b 两条真调 op:search 的门退役，§三-10b；③ 标题 14→13）；
> ISC 改为 **7 条** STARTUP（走 5 / 留 6 + engine/index.mjs，§三-14）；
> 新增 `clean-split-check.mjs`（§三-23 从人工核账升级为可重跑基线）与 `op-probe.mjs`（§四-2）。
> **"绿"= 收缩后全绿，不是带红过门**（§四-1 原文口径）。

单条重跑：`node engine/verify/t-cases.mjs T-2`。
G11 可指到装机位：`node engine/verify/tool-surface.mjs --dir <包根>`。

### G10 为什么必须存在（本项目的核心教训）

2026-11-03 真机事故：**六道门全绿，装上去一个工具都没有**。原因不是代码写错了，
而是**门测错了地方**：

```js
// 前五道门的统一写法（把被测函数绕过去了）
await entry.createEngine({ contentDir, level: 'error' });       // 直接 import 引擎
openTransport({ ..., seams: { engineRoot: '<硬写路径>' } });    // 直接注入路径
```

`resolveEngineRoot()` 和 `layout().modesDir` 这两个**真实解析函数**，
在门里一次都没被执行过 —— 它们里面的 bug 是**零覆盖**的。

G10 的写法：**一个接缝都不注入**，按 `package.json` 的 `main` 加载入口，
走真实解析，走完 `apply()`，数注册出几个工具。

> **一个函数只要在门里从没被真调用过，它就是零覆盖的 —— 哪怕它周围几十项断言全绿。**

G10 写好后**第一次运行**就抓出了第三个问题（`ours/session-memory.js` 强依赖
`systemPrompt.context`，而 `routing.js` 用的是 `section`），证明它有独立价值。

### G11 为什么必须存在（G10 覆盖不到的那一半）

G10 保证「工具注册得出来」，G11 保证「注册出来的工具**真的能干活**」。
1.0.0 把 11 工具折叠成 **1 位 `ctx`**（2026-11-04 定案：`ctx_run`→`ctx`，
`ctx_recall`→`op:'recall'`，不留旧名兜底），凡是按老工具名调引擎的代码都会静默失效：

```js
engine.call('ctx_index')  => 没有这个工具位，也没有这个 op
```

而这类调用几乎都包在 `catch { }` 里 → 错误被吞 → 功能**看起来在、实际什么都不做**。
2026-11-03 实测抓到 4 处（沙箱自动入库 / 压缩归档 / 沙箱闸门 / op:search）；
2026-11-04 改名折叠又抓到 4 处**同族变种**：CJK 适配按旧名分派、路由探测按旧名、
技能禁用映射按旧名、**SKILL.md 文档面还在教旧名**（G11 因此加第 ⑧ 项）；
同日文案面进 `descriptions/ctx.md` 后又补第 **⑨** 项 —— 防**反向漂移**：
.md 只是"存在"不够，必须对拍 **op:list 的返回 == ctx.md 本体 == 注册的工具描述**，
否则某次合并把描述换回 JS 拼的静态表，.md 还躺着、门③照样解析出 13 行，模型看到的却不是它。

> **语法对、import 可达、单元断言全绿 —— 都不排除"调了但没用"。**
> 只有真调用一次，才知道它是不是空的。

G11 的判据特意写成"过程"而非"不报错"：
② 旧名必须**全部调不通**（不留兜底 = 判据反向）；
⑤ ctx(op:index) 写进去必须**能被 op:recall 搜回来**（写接口不报错但没落库 = 缺陷原形态）；
④b 必须**只 new 客户端、什么都不传**再调 `op:search`（不靠调用方传 web）；
⑧ 技能文档里旧名只许出现在 no-longer-exists 语境（**工具面改动的覆盖面 = 代码+配置+文档**）；
⑨ 文案真源必须是 ctx.md，且首行 Example（2.0 倒序形态，维护方 11-03 定）。

## 二、两条必须知道的踩坑（都是真事）

### ① 回归器**拦截** `process.exit`

`all-blocks.mjs` 是同进程 `await import()` 跑各块 selftest。某块若调 `process.exit()`，
会**掐死整个回归器** —— 后面的块和汇总行根本不执行，把"红"伪装成"跑到第 N 项就没了"
（2026-11-03 qfmodel 抓到）。所以：

```
约定：块内一律 `process.exitCode = N`，不许 `process.exit()`。
      runner 侧也做了拦截（把 process.exit 转成"这一项红" + 标记错误），双层保险。
```

### ② 13-sandbox 的真跑组需要不受限宿主

`spawn(stdio:'pipe')` 在 DSH 受限沙箱下报 EPERM（受限令牌不能开匿名管道）。
13-sandbox 的 selftest 因此设计成：**契约/探测/围栏组照跑，真跑组探测到
`HOST_PIPE_DENIED` 就整体 SKIP + 退出码 2**（不假装成功）。

```
受限宿主：node blocks/13-sandbox/selftest.mjs  → exit 2（SKIP，不是失败）
放宽宿主：同上                                  → exit 0（30/30 全绿，2026-11-04 实测）
```

★ 2026-11-04 沙箱归一（S9.22）后本 selftest 的**新契约六条**（async reject/null/坏形状
→ fail-closed、白名单、拒 background、aborted 早退）全部落在"起进程之前"的判定段 ——
**受限宿主里它们同样是真判据**，不是摆设；这正是"await 假围栏"那刀的守门人。

## 三、写放大的**口径**（T-7，别再量错）

T-7 必须跟 P-02 同口径，否则比的不是同一个东西：

```
语料   = 同一句中文段落反复灌满 1 MB（字节精确）
分块   = 单 source、~250 块（每块约 4 KB，与 P-02 的"1MB/257chunk"同量级）
判据   = db 文件字节 / 原始内容字节
定稿   = 2.82×（P-02）；本引擎实测 2.78×；门槛 ≤3.0×
```

**反例（实现方踩过）**：用「100 个独立 source」测 → 4.22×。那是 FTS5 段数差异造成的虚高，
不是结构性写放大。P-02 自己就标注过"这是重建库口径，真实写入路径见 P-07"。

## 四、临时产物规矩（2026-11-04 重写）

**不许在源码里出现任何绝对路径。** 全包临时目录只有一个来源：`engine/libs/tempdir.js`。

```
建目录   一律 makeTempRunDir('label')   —— 不许裸 mkdirSync
立即回收 releaseTempRunDir(dir)         —— 一个进程跑很多轮时用
基址     os.tmpdir()                     —— 默认；别人的机器没有 F 盘
开发期   TEMP_DEV_DIR=<路径>             —— 环境变量指定，不写进源码
```

为什么这条是硬规矩（两个都踩过）：

- **硬编码 24 处** → 别人的机器没 F 盘，装上去 `createEngine` 直接抛。
  而七道门全在开发机上跑，**这个 bug 永远不会被自己的门看见**。
- **"改成 os.tmpdir()" 不等于解决** → 那只是把垃圾站从 F 盘挪到 C 盘。
  实测开发机 Temp 堆到 **997 MB / 1569 件**（单个 dbtest.db 683.9 MB），
  因为 24 处 mkdir 全是裸的，**没有任何一处登记"谁该删它"**。

所以 `tempdir.js` 自带三层回收：`exit` 钩子、`SIGINT/SIGTERM`、
以及**同前缀超 2h 残留兜底**（进程被 kill -9 时只有这道能收尸）。
兜底只删 `ctx-mode-*` 前缀 —— `os.tmpdir()` 是全机器共用的，**收自己的尸，不碰别人的**。

验收口径：**跑完门，临时目录条目数必须不变**（不是"看起来干净"）。

```
真库 F:\workspace\LongMem\context-mode\content\77ce2d56c3181724.db 开发期只读，任何门都不许写它。
```
