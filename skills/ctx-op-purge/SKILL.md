---
name: ctx-op-purge
description: |
  ctx 的 purge op：显式清除。scope=session|source|project，全部默认干跑，
  真删必须 dryRun:false。project=整库蒸发，维护方说不行就不许试。
  触发：/ctx-op-purge
user-invocable: true
---

# ctx({op:"purge"})

```js
ctx({ op:"purge", scope:"session", session:"<会话id>" })   // 干跑，只报数
ctx({ op:"purge", scope:"session", session:"<会话id>", dryRun:false })
ctx({ op:"purge", scope:"source",  source:"<label>", dryRun:false })
ctx({ op:"purge", scope:"project" })                       // 永远报错，见下
```

## 三个作用域

| scope | 删什么 | 保留什么 |
|---|---|---|
| `session` | 该会话归属的源 + 块 + trigram | 兄弟会话、库文件 |
| `source` | 单个 label 的源 + 块 + trigram | 其余全部 |
| `project` | 整库 | 无 —— 所以**报错拒绝**，不走 op |

## ★ 硬规则：整库删除必须维护方同意

- `scope:"project"` = **整个库蒸发**（三张表全清、不可撤销、库里什么都不剩）。
- 工具层**直接报错拒绝**（`PURGE_PROJECT_NEEDS_OWNER`），不管带不带 `dryRun:false`。
- **不要试、不要绕**：想删整库只能请维护方手动执行。
- 要删局部就用 `scope:"session"` / `scope:"source"` —— 那两条是允许真删的。

## 硬规则

- **默认干跑**：不带 `dryRun:false` 一行都不删，只回"将命中 N 个源"。
- 真删后才回"已删 sources N / chunks N / trigram N"；
  干跑回的是"**未删任何东西**：将命中 N"。
  看到"干跑"就当没删，别拿它当已清理的证据。
- **`dryRun` 可能以字符串到达**：写 `dryRun:false` 或 `"false"` 都算真删；
  写 `true`/`"true"`/不写 = 干跑。**只有明确给 false 才真删。**
- `/clear` 和 `/compact` **不影响**库里任何数据。
- 删了没有撤销：要就重新 `index`。

## 长久库

`purge` 不碰长久库。删长久记忆只有一条路：`ctx({op:"memory", action:"delete", id:N})`。
