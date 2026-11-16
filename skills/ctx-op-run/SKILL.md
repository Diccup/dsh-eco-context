---
name: ctx-op-run
description: |
  ctx 的 run op：跑代码、跑命令、跑多条命令。正文 >5000 B 自动入库只回定位符。
  沙箱分工与标准流程写在本文。
  触发：/ctx-op-run
user-invocable: true
---

# ctx({op:"run"})

## 形状

```js
ctx({ op:"run", code:"console.log(1)" })                       // language 默认 javascript
ctx({ op:"run", language:"javascript", code:"..." })
ctx({ op:"run", commands:["git status --short","git log -1 --oneline"] })   // 批量
ctx({ op:"run", file:"<绝对路径>", code:"…读 process.env.CTX_FILE…" })       // 路径进 CTX_FILE
```

- `language` 默认 `javascript`。12 个可选：javascript / typescript / python / shell /
  ruby / go / rust / php / perl / r / elixir / csharp。
- **实测能起的**：`javascript`（受管 node）、`python`（随包 python）、`shell`。
  其余 9 种本机没装对应运行时 → 起不来，会被明确拒绝（不是报错就重试的事）。
- ⭐ **python 用 DSH 随包那个，不要指望 PATH 上的 `python`**：
  `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（实测 3.12.14）。
  PATH 上的 `python.exe` 是 **WindowsApps 的 0 字节 App Execution Alias**，实测 `--version`
  空输出、**exit 9009**。要跑现成 `.py` 文件时优先 `language:"python"`（探测已认随包那个，
  `source=dsh-managed`）；必须在 shell 里手敲路径时，用上面那条绝对路径。
  ⚠️ 2026-11-06 实测教训：有一个会话为了"找 python"花了 **91.4 秒 / 5 次往返** —— 别重演。
- ⭐ **`shell` 落到哪个 shell 由环境决定，不是我们指定**：
  pwsh 7 → Windows PowerShell 5.1 → cmd.exe（`runtime-probe.js:211-214` 的兜底链）。
  三种都能跑，**别因为本机装了 7 就假设别人的机器也有 7**。
  PowerShell（7 和 5.1 都算）会自动加 BOM + UTF-8 前导，中文不乱码。
- ⚠️ **`pwsh` 不是工具名**：它只是 `language:"shell"` 最后落到的那个 shell。
  命令一律走这里，**不要调宿主那个叫 `pwsh` 的工具**（那个位可能没开）。
- `file` **不代替 code**：它只把路径塞进 `process.env.CTX_FILE`，正文仍要写 `code`。
- `intent`：正文超 5000 B 时用它，引擎替你选块返回。
- `timeoutMs` 照传；工具级超时 10 分钟。
- ★ **没有 `background` 参数**（S9.39 维护方令删）：后台作业在当前宿主环境跑不了
  （`SANDBOX_ERROR: has no live agent`），且 ctx 是独占的、不能并发跑两个 ——
  长任务直接跑，靠 `timeoutMs` 给足时间即可。

## 沙箱分工（这条最常踩）

- 受限会话里 `run` 收 **javascript 和 shell**：**读不限，写只限工作区**（区外 EPERM，实测）。
- 受限态**抓不到子进程输出**（命名管道 EPERM，已知边界）—— 但**文件描述符重定向可行**
  （R11 实测），所以 `shell` 照样能跑、输出照样能回来。标准流程：
  **命令走 `ctx({op:"run",language:"shell"})` → 大输出落盘成文件 →
  再 `ctx({op:"run"})` 用 javascript 读那个文件做分析。**
  读文件、解析、统计、比对这些活照旧全走这里，一点不打折。
- ⚠️ **不要去调宿主那个叫 `pwsh` 的工具**：它可能没开（维护方 2026-11-05 就按
  `library/tool-switch.json` `{"denied":["pwsh"]}` 关着它）。**只用 ctx。**
- 无沙箱的会话里 shell / perl 直接可用，命令可以整条搬进来。

## 输出

- 只 `console.log` 结论，不回吐原始数据。
- >5000 B 整份入库，回 source 标签 + 取回提示；正文一个字节都不进对话。
- 想让引擎选块：`ctx({op:"run", intent:"<要什么>", code:"…"})`。
- ★ **2026-11-14 起：别的工具的大输出也会入库**（宿主 `read` / `grep` / `pwsh` / 网页 / MCP，
  阈值 4096 B，source 形如 `tool:read:…`）。所以：
  - 你在 `run` 里自己读大文件、算完只打结论，**仍然是最优解**（少一次入库、少一份冗余）；
  - 但宿主 `read` 一个大文件**不再等于把整份正文灌进对话**了 —— 它会入库并给你 `tool:read:…` 标签；
  - 四条豁免（不入库、原样给）：`ctx` 自己的结果 / 带 `offset·limit·view_range` 的读取 /
    agent 自己的规则文件（`AGENTS.md`、`skills/**` 等）/ 含非文本块的结果。
