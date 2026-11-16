> [!IMPORTANT]
> **本项目由 AI 辅助生成（AI-generated / AI-assisted）。**
> 代码与文档均经人工审阅与本机验证，但**可能**存在缺陷或不准确之处，使用前请自行复核。
>
> **免责声明：本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
> 使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
> 请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。**
> 完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

# dsh-eco-context 1.0.0

把 DSH 的上下文窗口从"塞满就丢"改成"按需取用"：大输出、长文档、搜索结果全部落本地库，
模型只看摘要 + 指针，需要细节时再用 `ctx` 取回来。

**工具面只有 1 个**（从旧版 11 个折叠而来，2026-11-04 定案），schema 从 27,916 B 降到 ≤1.2 KB：

| 工具 | 作用 |
|---|---|
| `ctx` | 一个壳，13 个 `op` 从它的 `op` 参数分派 |

`ctx` 的 13 个 op：

```
run      跑命令/脚本（12 种语言；受限会话按实测白名单+512KB 顶，全在引擎 13-sandbox 里执行）
search   搜网页 / 抓正文
recall   从本地库召回内容（三榜 RRF，命中续命；原独立工具位 ctx_recall 并入）
index    把文件/目录/文本写进 14 天临时库
remember 写长久记忆（≤64KB，永不自动清理）
pin      把某批块钉进长久记忆
unpin    解钉，内容交回
memory   读长久记忆（不带正文）
stats    库与记忆的统计
doctor   体检（journal/synchronous/integrity…）
maint    维护（retention 清理 / optimize / checkpoint / vacuum）
purge    三档清理（默认 dryRun，必须显式才真删）
list     列出这张 op 表（自描述）
```

---

## 目录形态

```
dsh-eco-context/                        ← 发布包
├── platform/     ← 平台匹配层：把这套软件适配到 DSH/Cordis
├── engine/       ← 平台无关引擎：17 块积木 + 3 个 libs
├── ours/         ← 自有增强模块（输出收敛/会话记忆/压缩归档/CJK）
├── skills/       ← 捆绑技能文档
└── vendor/context-mode/LICENSE  ← 第三方许可声明（仅 LICENSE 文本，不含代码）
```

网页抓取不在本包内 —— 那是独立的 `dsh-fp-search` 插件的活。
本包不依赖它、不 import 它。

### platform/ 是干什么的

`engine/` 是纯库：`createEngine()` 给你一个引擎实例，它不认识 Cordis、不认识
`ctx.get('tools')`、不知道工具描述怎么渲染、不知道提示词往哪注入。

**这些"宿主长什么样"的知识就是 platform/ 的全部职责。** 以后要接别的平台，
新增一个 `platform-xxx/` 即可，`engine/` 一行不用改。


---

## 引擎：17 块积木

```
01-core       常量与契约（user_version 四态 / 12 语言矩阵 / DEFAULTS）
02-project    项目根与围栏（isInside / realpath 闸 / junction 逃逸拦截）
03-storage    数据根、库文件命名、PRAGMA 基线、WAL 卫生、损坏重开
04-store      schema 迁移（v0 有表拒迁 / v>认知只读）+ FTS5 查询模板
05-analyze    分块（markdown 标题栈 / 代码块不切断 / 超限段拆）
06-gram       中文 gram 通道（索引侧折叠空白 / 查询侧绝不折叠）
07-tokenize   词与表达式（短语保序 / 停用词 / 模糊纠错）
08-writer     双表写入（chunks 10 列 / chunks_trigram 9 列）
09-reader     三榜读取（porter + gram + trigram）
10-recall     RRF(K=60) 融合 + 四 boost + fuzzy 兜底
11-memory     长久记忆（64KB 闸 / pin 护栏 / category 校验）
12-lifecycle  保留期清理、完整性、真空、僵尸库
13-sandbox    执行面：12 语言矩阵 + **宿主沙箱闸门在这里接**（async confine、
              fail-closed、受限白名单/512KB 顶/拒 background；2026-11-04 沙箱归一，
              桥侧 guard 已删 —— 受限 run 也真进引擎）
14-tools      工具面折叠（11 → 1 位 ctx，13 个 op）；**文案真源在
              `14-tools/descriptions/ctx.md`** —— 改描述只改那个 .md，不碰源码
              （2.0 形态：Example→必填→是什么→op 表）
15-hooks      压缩归档、道 A/道 B 接力
16-entry      装配与调度（三槽只三槽：rank / 写 / 读）
17-plugs      插拔点
```

块之间**只准**走 `registry.mjs`，跨块 import 为 0。

---

## 两道记忆接力

- **道 A（工作期）**：同对话已推过的内容不重复推；给的是指针（"要细节调 `op=memory`"），
  永不带正文，≤512 B。
- **道 B（压缩期）**：压缩时先归档再出 recap 卡（≤2 整块 + 指针，总量 ~2 KB）。
- **两池独立**：道 A 推过的东西，道 B 仍能带出来（不共用一个 seen 集合）。

---

## 硬指标

| 项 | 指标 | 实测 |
|---|---|---|
| 写放大（重建库口径） | ≤3.0× | **2.78×** |
| 单条查询 P95 | ≤15 ms | 达标 |
| 续命写频次 | 每日 ≤1 次 | 降 94% |
| 中文 >8 字查询命中 | 100% | 达标（旧版 0%）|
| 工具 schema 体积 | ≤1.2 KB | 达标（旧版 27,916 B）|

写放大 2.78× 是**重建库口径**（一次灌满 1 MB 再量库大小），
**不等于持续写入时的真实开销** —— 真实增量写入路径的写放大在 **10× 量级**
（同样这句 P-02 自己也标注过："这是重建库口径，真实写入路径见 P-07"）。

重建口径下之所以能压到 2.78×，关键在 `script_ngrams` **只写进 `chunks`**、不进
`chunks_trigram`（表数量不变，只加一列）；但每条新内容进库仍要写
`chunks` + `chunks_trigram` + `sources` 三处，**增量写放大天然远高于重建口径**。

> 想要真实增量口径的数字，请看库定稿 P-07，不要拿这里这行重建口径的数字去做容量规划。

---

## 安装

三条路，任选：

1. **DSH 插件市场**：按包名 `dsh-eco-context` 装 —— 最省事，装完直接能用。
2. **手改**（三条都要做，缺一不加载）：
   ```text
   ① 把整个包拷到  %USERPROFILE%\.dsh\plugins\dsh-eco-context\
   ② 在 profile 的 package.json 里加一行：
        "dsh-eco-context": "file:../../plugins/dsh-eco-context"
   ③ 在 profile 的 package.json 的 dsh.profile.bundles 数组末尾加 "dsh-eco-context"
   然后在 profile 目录跑一次 pnpm install，让它建好 node_modules 链接
   ```
   > DSH **不扫** `plugins\` 目录 —— 光把文件夹放进去、不注册，永远不会加载。
   > ②③ 两条缺一都不加载（只加 dependencies 不加 bundles = 包能解析但没人 apply；
   > 只加 bundles 不加 dependencies = patch 读得到、包解析不到）。
   > profile 目录看 `~\.dsh\profiles\` 下有哪些文件夹，通常就一个。
3. **按包名装**：在 profile 目录跑 `pnpm add file:../../plugins/dsh-eco-context`，再补 ③ 那行 bundles。

装完新建会话，模型调一次 `ctx({op:"list"})` 出 op 表就成了。
需要完全退出 DSH 重开才生效的场合：改了 `cordis.patch.yml` 或 profile 注册内容。

### 数据根在哪

默认落在插件目录下的 `engine\.content\`（跟着安装位置走）。
想指到别处：在 profile 的 `cordis.patch.yml` 里加覆盖块写 `contentDir`，
或设环境变量 `CONTEXT_MODE_DIR`。

---

## 自检

```bash
node engine/index.mjs --selftest          # G1：17 块 / 13 op / 可克隆 / 真写真搜
node engine/verify/all-blocks.mjs         # 全量回归 19 项
node engine/verify/t-cases.mjs            # T-1…T-12
node engine/verify/bridge-contract.mjs    # 平台-引擎契约 13 项（含沙箱归一反证）
node engine/verify/release-check.mjs      # G9 成品九项（在成品目录里验）
node engine/verify/install-path.mjs       # G10 真机安装链路 9 项（含审批流五路）
node engine/verify/tool-surface.mjs       # G11 工具面一致性 11 项（含桥=纯翻译层）
```

---

## 许可

`vendor/context-mode/LICENSE` 是第三方项目 context-mode 的 **Elastic License 2.0** 文本，
保留它是为了履行该许可的署名与条款要求。**本包的引擎代码为独立实现**，
本包主体按 MIT 授权（见 `LICENSE`）。
