---
name: ctx-op-recall
description: |
  ctx 的 recall op：从本地库召回。三榜 RRF（porter/gram/trigram）融合 + 4 项加权，
  多问分节不互相收窄，命中即给 source 续命。查询写 2-4 个具体词。
  触发：/ctx-op-recall
user-invocable: true
---

# ctx({op:"recall"})

```js
ctx({ op:"recall", queries:["具体词1","具体词2"] })
ctx({ op:"recall", queries:["…"], source:"run:shell:2026…" })   // 收窄到一个源（run:<语言>:…）
ctx({ op:"recall", queries:["…"], source:"run:shell:2026…", full:true })   // ★ 整源全文，不切窗口
ctx({ op:"recall", queries:["…"], limit:5, offset:0 })
ctx({ op:"recall", queries:["…"], contentType:"code" })
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `queries` | 必填 | 数组，每问独立成节，**不互相收窄** |
| `source` | — | 精确或部分匹配的 source 标签 |
| `full` | false | ★ `true` = **要全文**：给了精确 `source` 就整源按原顺序拼回（≤64KB），不给 source 就回 search 命中的整块、不切窗口 |
| `limit` | 3 | 每问取几条 |
| `offset` | 0 | 翻页 |
| `contentType` | — | `code` 之类 |
| `sessionId` | — | 按会话归属加权 |

## 查询写法

- **2-4 个具体的词**，不要整句、不要空泛。
- 要命中源码 / 命令 / 路径就写那个 token 本身：`releases/1.0.0`、`INTENT_INDEX_BYTES`。
- 多问一次发完（`queries:[a,b,c]`），别拆成三次调用。

## 什么时候用

- 前面的命令输出被入库了（回了 `source "run:…"`），现在要取里面某段。
- 之前 `index` 过的文件 / 目录，不想重新读一遍原文。
- 会话被压缩过，要翻前面的事实与决定。
- **要整份原文**（不是"某段"）：加 `full:true`，见下。

## 片段 vs 全文（★ 2026-11-12 维护方定案）

默认返回**窗口片段**：每块最多 `SNIPPET_MAX_BYTES = 800` 字节，按查询词命中位置切一段。
这是省上下文的设计，不是 bug。片段末尾会带一行标注：

```
〔片段：780/4070 B · 本段 13 行 / 原文 68 行 —— 要全文加 full:true〕
```

看到这行就说明**你手上的不是全部**。要全部：

```js
ctx({ op:"recall", queries:["随便一个词"], source:"run:shell:20261112…", full:true })
```

- 给了**精确 source**（抄 `run` 回执里那个完整标签）→ 走整源拼回，**真全文**，
  连窗口会切掉的中段都在。
- 没给精确 source → 退回 search 命中的块，**整块不切**。
- 预算 64 KB：超了**整块跳过**并在末尾报"另 N 块没显示"，**不截半块**（半块最容易被误读成"原文就这么长"）。
- 临时库 14 天删线，过期标签会报 `NO_INPUT` 并说清是哪一种情况。

## 边界

- 默认召回是**片段**；要全文用 `full:true`，要精确原文改文件 → 用 `read`。
- 命中会给 source 续命（14 天删线重置，每日节流）。
- 库里没有就是没有，别把 `(0 命中)` 当成"内容不存在"的证据去下结论。
