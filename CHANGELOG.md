# Changelog

本文件记录 dsh-eco-context 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-16

首个公开发布版。

### 新增

- 上下文管理引擎：把 DSH 的上下文窗口从"塞满就丢"改成"按需取用"。
  大输出、长文档、搜索结果全部落本地库，模型只看摘要 + 指针，需要细节时再取回来。
- 工具面只有 1 个：`ctx`（一个壳，13 个 `op` 从 `op` 参数分派）。
  `run` / `search` / `recall` / `index` / `remember` / `pin` / `unpin` / `memory` /
  `stats` / `doctor` / `maint` / `purge` / `list`。
- 17 块引擎积木 + 3 个 libs，平台无关；`platform/` 是唯一的宿主适配层。
- 捆绑 6 份技能文档（`ctx` / `ctx-op-run` / `ctx-op-index` / `ctx-op-recall` /
  `ctx-op-stats` / `ctx-op-purge`）。

### 变更

- **发布版可移植化**：
  - 临时目录解析统一走 `engine/libs/tempdir.js`（系统临时目录 / `TEMP_DEV_DIR`），
    成品里不留任何盘符。
  - `engine/verify/install-path.mjs` 的依赖来源由写死 `C:\Users\Diccup\...`
    改为按当前用户家目录 + 实际存在的 profile 目录名探测。
  - 引擎代码注释里的开发机绝对路径改为通用口径。

### 许可

- 本包 MIT（见 `LICENSE`）。
- `vendor/context-mode/` 只保留第三方 /`52sujiu/context-mode` 的 **LICENSE 文本**与
  package.json（ELv2 声明与溯源），**不含任何引擎实现代码**。
  详见 [LICENSING.md](./LICENSING.md)。
