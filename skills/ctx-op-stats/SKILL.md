---
name: ctx-op-stats
description: |
  ctx 的运维读面：stats 看库现状、doctor 体检、maint 做保留期/优化/checkpoint/
  完整性/VACUUM。**stats 里没有任何"省了多少"的指标**——只有库现状。
  触发：/ctx-op-stats
user-invocable: true
---

# stats / doctor / maint

## stats —— 只有事实，没有"节约率"

```js
ctx({ op:"stats" })
```

返回五块，全**没有**节约统计：

| 块 | 内容 |
|---|---|
| `db` | sources / chunks / codeChunks / user_version / wal_bytes / accessed_today |
| `state` | totalChunks / totalSources / lastIndexedAt / totalChunksBilled / maxUserVersion |
| `fileBytes` + `fileBytesDetail` | 磁盘占用（主库 + WAL 分开列） |
| `memory` | 长久库行数 / 字节 / 上限 |
| `hints` | seenA / seenB / hintShownCount |

**没有 `savings` / `savedTokens` / `ratio` 这类字段。**
不要编造"省了 N 倍""92% 数据留在沙箱"——引擎不统计这个，说了就是假数据。

能说的只有：库里有多少块、占多少磁盘、长久库几行。
真想知道单次省了多少，只能自己算：命令输出原始字节 vs 实际回到对话的字节。

## doctor

```js
ctx({ op:"doctor" })
ctx({ op:"doctor", fix:true })
```

检查项：journal mode、synchronous、user_version、完整性（sqlite + FTS5）、WAL 卫生、孤儿 WAL。
输出已带 `✓` / `✗` 与修复提示，**原样呈现**。

`fix:true` 只做可逆维护（FTS optimize + checkpoint PASSIVE），**不动结构、不删数据**。

## maint

```js
ctx({ op:"maint", action:"plan" })                    // 现在该做什么
ctx({ op:"maint", action:"retention" })               // 清 14 天过期
ctx({ op:"maint", action:"optimize" })                // FTS5 优化
ctx({ op:"maint", action:"checkpoint" })              // WAL 合并
ctx({ op:"maint", action:"integrity" })               // 完整性
ctx({ op:"maint", action:"vacuum", dryRun:false })    // 真压缩，很大很慢
```

- 全部默认**干跑**，只报数不真删；真跑要 `dryRun:false`。
- `vacuum` 上百 MB 的库会跑很久，先干看能回收多少再决定。
