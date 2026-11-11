# Herdr DAG Studio — 设计与实施计划

## 1. 产品定位

`herdr-dag-studio` 是一个面向 OmO workflow 的 **Herdr 侧栏 TUI**，参考
`jc01rho/omo-herdr-dag` 的“扩展采集 + 独立 viewer 读快照”架构，但重写展示层：

- 三栏仪表盘：运行/任务列表、DAG 画布、节点详情。
- 持续动画：运行呼吸色、spinner、边流动点、进度条微光、选中态过渡、
  footer 状态提示、平滑滚动（无过冲）。
- 更完整的细节：耗时、token、轮次、工具调用、重试、活动阶段、
  模型思考/回复摘录、最近日志（详细模式）、依赖、子任务、错误、运行级统计。
- 自适应布局：宽屏三栏；窄屏或紧凑 pane 使用 duty 单面布局，只显示 RUNS、CELLS 和当前对象/详情，不渲染图谱；`S` 只在 112 列以上的宽屏生效。
- 演示模式：无需 OmO/Herdr，直接在当前终端用确定性假数据渲染并持续演化。
- 中英文界面：导航栏下方有设置菜单，语言选择持久化到
  `~/.config/nero-herdr-dag/config.json`。
- 兼容参考插件的 v1 和 v2 快照；自己的扩展写出 v3 快照。

产品名：**Herdr DAG Studio**  
包名：`herdr-dag-studio`  
命令：`dag-studio`  
OmO 扩展入口：`extensions/omo-herdr-dag-studio.js`

## 2. 设计原则

1. **展示层与采集层解耦**：viewer 只读快照，扩展只写快照。
2. **动画服务于状态理解**：只让运行中、最近变化、选中目标动；
   在设置中关闭动画（或使用 `--no-motion`）后信息仍然完整。
3. **细节不打断总览**：主画布始终可见，详情面板按选中项切换。
4. **窄终端先保信息**：先隐藏侧栏，再压缩详情，不横向溢出。
5. **确定性**：假数据由时间函数和固定种子生成，任意时刻可复现。
6. **零运行时依赖**：只用 Node.js 内置模块。
7. **安全**：所有外部文本清理 ANSI/控制字符；不落盘 prompt、完整输出、完整回复或 transcript；只为详情面板保留有界、清理后的思考/回复摘录。

## 3. 界面布局

```text
╭─ DAG STUDIO ───────────────────────────────────────────────────────────────╮
│ integration review · RUNNING            ● LIVE   14:03:22   session 7f3a  │
╰────────────────────────────────────────────────────────────────────────────╯
╭─ RUNS (3) ─────────╮ ╭─ GRAPH · integration review ──────────────────────╮ ╭─ NODE · build-api ─────────╮
│ ▸ ● integration    │ │  ╭──────────────────╮   ╭──────────────────╮    │ │ ● running      00:01:23    │
│   ███████░░░ 72%   │ │  │ ● build-api  72% │──▶│ ● build-ui   41% │    │ │ acme/atlas-code            │
│   ○ docs polish    │ │  │ ███████░░░░░░░░  │   │ ████░░░░░░░░░░░  │    │ │ ███████████░░░░░░ 72%      │
│   × release audit  │ │  │ ⠹ editing route  │   │ ⠼ rendering...   │    │ │ in 12.4k  out 3.1k         │
│                    │ │  ╰──────────────────╯   ╰──────────────────╯    │ │ turns 8   tools 21         │
│ TASKS (4)          │ │          │                      │               │ │ activity: editing routes   │
│ ● refresh index    │ │          ▼                      ▼               │ │ ▁▂▃▅▆▇▆▅▃▂ 24 tok/s        │
│   ████░░░░░ 35%    │ │  ╭──────────────────╮   ╭──────────────────╮    │ │ ← intake, scaffold         │
│ ✓ cleanup branches │ │  │ ◌ verify-evidence│   │ ✓ security       │    │ │ → verify-evidence          │
│                    │ │  ╰──────────────────╯   ╰──────────────────╯    │ │ subtasks: lint ✓  tests ⠹  │
│ LEGEND             │ │  dependencies: build-api → build-ui → ...        │ │                            │
╰────────────────────╯ ╰──────────────────────────────────────────────────╯ ╰────────────────────────────╯
 ?  ●run ✓done ×fail ◌wait                                      ● LIVE  follow:ON
 session demo-7f3a · 60 fps · theme system
```

### 布局断点

- `width >= 112`：三栏可用。侧栏 26–34 列，详情 34–44 列，中间为画布。
- `width < 112`：duty 单面布局，只显示 RUNS、CELLS 和当前对象/详情，不渲染图谱；`S` 只在宽屏生效。
- `--pane` 启动时优先紧凑；pane 变宽/全屏后自动恢复导航栏，仍可用 `S` 手动切换。

### 面板

1. **Header**：渐变标题、当前 run、状态徽章、LIVE 脉搏点、时钟、会话短 ID。
2. **Sidebar**：RUNS 列表（状态、迷你进度条、计数）、TASKS 列表、
   SETTINGS 设置入口；图例移到 footer。
3. **Graph**：拓扑分层节点卡片；运行中 spinner/呼吸边框；边流动点；
   选中发光；折叠节点仅保留标题行；底部显示依赖边列表。
4. **Details**：状态、耗时、agent/model、进度条、token 输入输出、
   轮次、工具调用、重试、活动阶段、模型思考/回复摘录、token 速率 sparkline、
   前驱/后继、子任务、错误；选中 run 时显示运行汇总（token、成本、缓存命中、
   墙钟/忙碌时长、关键路径、并行度与证据覆盖度）；详细模式追加最近日志。
5. **Footer**：图例、可点击的 `? 帮助` 入口、跟随开关、session、fps、palette。
6. **Footer 状态提示**：状态变化显示在 footer 右侧 5 秒；`?` 帮助仍为覆盖层。

## 4. 动画系统

交互终端只在有活动动画（运行中任务、滚动、demo）时按 60 fps 刷新；宽屏三栏布局（≥112 列）静态时也不低于 24 fps，窄屏 duty 布局降到 1 fps，pager 暂停帧循环；输入/状态变化立即请求一帧。`--fps N` 可在 2-120 之间覆盖活动帧率（实际帧率受终端刷新率与终端尺寸影响）；所有动画由 `now` 推导，不依赖帧计数累积。

| 动画 | 实现 |
| --- | --- |
| 运行 spinner | 10 帧 braille 循环 |
| 运行呼吸 | 边框/状态色在基色与亮色间正弦插值 |
| 边流动 | 沿 Manhattan 路径按时间推进亮色 `•` |
| 进度微光 | 高亮段在已完成区间内往返 |
| 选中态 | 边框颜色脉冲 + 柔和背景 |
| 状态变化 | 节点边框 flash 1.2s + toast |
| 平滑滚动 | 基于时间常数的指数缓动，无过冲；`↑↓` 一行；PageUp/PageDown 与鼠标滚轮使用同一分区步长：图谱为视口高度减 4 行，其他区域为半个视口 |
| 时钟 | 每秒更新 |
| LIVE 点 | 1.4s 呼吸 |
| 状态提示 | 显示在 footer 右侧，5s 后消失，不覆盖面板内容 |

在设置菜单关闭 Animation（或使用 `--no-motion`）后保留静态 spinner 与完整信息。

## 5. 假数据场景

`src/demo.mjs` 提供确定性的 `DemoEngine`，周期 160 秒，时间轴如下：

| 节点 | 开始 | 时长 | 依赖 |
| --- | --- | --- | --- |
| intake | 0 | 6s | — |
| scaffold | 6 | 12s | intake |
| api | 18 | 52s | scaffold |
| ui | 18 | 57s | scaffold |
| security | 18 | 22s | scaffold |
| tests | 70 | 18s | api |
| docs | 75 | 23s | api, ui |
| gate | 98 | 20s | tests, security, docs |
| release | 118 | 20s | gate |
| 完成保持 | 138 | 22s | — |

状态由绝对时间推导：未到开始时间且依赖未完成 = `blocked`，
依赖完成但未开始 = `pending`，区间内 = `running`，超过 = `completed`。
运行中节点进度、token、轮次、工具数、活动文本随时间增长。
周期末尾全部完成，随后重置并产生一组 toast。

另外两条 run 提供已完成/失败样本：

- `docs polish`：4 节点全部完成。
- `release audit`：5 节点，一个 `failed`（含错误），一个 `cancelled`。

独立任务：

- `refresh dependency index`：running，35% 起，循环。
- `cleanup stale branches`：completed。
- `probe GPU runner`：pending。

子任务：`build-api` 下挂 lint / typecheck / unit tests，状态随父进度变化。

`bun run demo` 直接进入演示；`bun run make-demo` 写出
`demo/snapshot.json` 供静态检查。

### Goldbach 证明尝试

默认 demo 还包含一个静态的 `run_goldbach`（`Goldbach proof attempt`）用例：
15 个节点、16 条边、21 个 Goldbach 主题任务和 25 个子任务。节点覆盖
命题形式化、素数筛、小范围穷举、4e18 有限验证、配对搜索、Lean 形式化与
kernel 检查、反例搜索、解析例外集估计、归纳步骤、评审、证据和发布。

该 run 被标记为 `failed`：`analytic-bound` 和 `induction-step` 分别失败，
评审/证据/报告被阻塞，发布声明取消。这是复杂失败 workflow 的展示样本，
不是对哥德巴赫猜想的真实证明（该猜想仍未解决）。

## 6. 快照协议 v3

```json
{
  "version": 3,
  "sessionId": "demo-7f3a",
  "mode": "live",
  "connected": true,
  "language": "en",
  "generatedAt": "2026-11-09T…",
  "provenance": {
    "origin": "controller",
    "statePath": "/home/me/.omo/agent/herdr-dag-studio/0123456789abcdef01234567.json",
    "taskStateDir": "/home/me/.omo/agent/projects/my-repo-d1641f7e/senpi-task",
    "capturedAt": "2026-11-09T…",
    "view": "watch"
  },
  "sources": [{
    "id": "agent-project-1234abcd",
    "label": "host store",
    "origin": "agent-project",
    "root": "/home/me/.omo/agent/projects/my-repo-d1641f7e/senpi-task",
    "status": "ok",
    "tasks": {"files": 12, "accepted": 12, "foreign": 0, "invalid": 0},
    "runs": {"files": 4, "accepted": 4, "foreign": 0, "invalid": 0},
    "scannedAt": "2026-11-09T…"
  }],
  "runs": [{
    "id": "run_integration",
    "name": "integration review",
    "status": "running",
    "createdAt": "…",
    "updatedAt": "…",
    "nodes": [{
      "id": "api",
      "label": "build-api",
      "state": "running",
      "attempt": 1,
      "taskId": "st_api",
      "startedAt": "…",
      "completedAt": null,
      "error": null
    }],
    "edges": [{"from": "api", "to": "tests"}]
  }],
  "tasks": [{
    "id": "st_api",
    "description": "Build the API layer",
    "agent": "forge",
    "model": "acme/atlas-code",
    "status": "running",
    "progress": "editing src/api/routes.ts",
    "percent": 72,
    "tokensIn": 12400,
    "tokensOut": 3100,
    "tokenRate": [12, 18, 24, 31, 26],
    "turns": 8,
    "toolCalls": 21,
    "retries": 0,
    "startedAt": "…",
    "completedAt": null,
    "activity": {"phase": "text", "text": "…", "since": 0, "lastAt": 0},
    "thinking": "bounded reasoning excerpt…",
    "reply": "bounded reply excerpt…",
    "logs": ["…"],
    "children": [{"id": "st_lint", "description": "lint", "status": "completed"}]
  }]
}
```

viewer 同时接受参考插件的 v1 和 v2：缺省字段由 `model.normalizeSnapshot()` 补齐。

`mode` 为 `live`（连接的 controller 快照）、`saved`（断开连接的捕获）或 `demo`（内置演示）。`provenance` 记录来源（`controller`、`demo-engine`、`legacy-snapshot` 或 `viewer-placeholder`）、状态文件、任务存储根目录、采集时间和查看方式（`watch` 或 `once`）。`sources` 列出 controller 扫描的任务和 checkpoint 存储，以及各存储的计数、扫描时间和错误。viewer 会根据记录推导每个字段的来源（`recorded`、`derived`、`simulated`、`unavailable` 或 `unknown`）。

## 7. 模块地图

```text
bin/dag-studio.mjs        CLI: install / uninstall / demo / view / version
extension.mjs             OmO 生命周期、事件订阅、/dag-studio
src/text.mjs              grapheme、宽字符、fit/fitTail/wrap
src/theme.mjs             调色板、truecolor/256 色、颜色插值
src/canvas.mjs            单元格画布、边框、裁剪、ANSI 输出
src/model.mjs             快照 v1/v2/v3 规范化、模式与字段来源、拓扑分层
src/demo.mjs              周期性假数据引擎
src/graph.mjs             DAG 布局、线网、流动点
src/render.mjs            仪表盘布局、侧栏、详情、header/footer/toast/设置菜单/help
src/i18n.mjs              英文/中文文案表与插值
src/config.mjs            语言/主题配置读取与原子保存（~/.config/nero-herdr-dag）、STALE 阈值
src/scroll.mjs            滚动意图、区域命中、滚动条几何与指数缓动
src/run-summary.mjs      运行级聚合（token/成本/缓存/时长/关键路径/并行度）
src/viewer.mjs            主循环、输入、跟随、平滑滚动、鼠标点击与滚轮、文件监听
src/view-state.mjs        视图偏好 sidecar、112 列布局断点、切换器选择
src/storage.mjs           原子 JSON 读写
src/controller.mjs        事件串行队列、快照写入、pane 生命周期
src/task-data.mjs         任务存储读取、合并、父子关系
src/stream-tap.mjs        子任务流式活动捕获
src/clipboard.mjs         失败诊断卡、记录路径校验、OSC52/pager 证据复制
src/mouse.mjs             SGR/X10 鼠标事件解析
src/omo.mjs               OmO agent 目录、project key、主题与明暗外观
src/todo-title.mjs        OmO TODO 事件到 run 标题的匹配
src/herdr.mjs             herdr pane CLI 封装
src/runtime.mjs           Bun 1.4+ / Node 24+ 探测
src/retention.mjs         过期快照清理
scripts/install.mjs       分代安装
scripts/uninstall.mjs     安全卸载（保留配置与状态）
Makefile                    install / update / uninstall 生命周期
scripts/build.mjs         语法检查 + dist
scripts/make-demo.mjs     生成 demo/snapshot.json
test/*.test.mjs           模型/演示/渲染单元测试
```

## 8. 实施清单

- [x] 设计文档与快照协议
- [x] 包、CLI、配置脚手架
- [x] 文本宽度、颜色主题
- [x] 单元格画布与边框
- [x] 模型规范化与拓扑
- [x] 确定性演示引擎
- [x] 响应式仪表盘布局
- [x] 动画 DAG 画布与边
- [x] 侧栏 run/task 面板
- [x] 详情面板与 sparkline
- [x] 模型思考/回复摘录与详细日志模式
- [x] header/footer/toast/help
- [x] 中英文界面、设置菜单、语言配置持久化
- [x] 复杂 Goldbach 证明尝试 demo（15 节点、21 个任务/子任务）
- [x] viewer 主循环、按键、跟随
- [x] 平滑滚动、鼠标滚轮与点击选中
- [x] 运行级汇总（token、成本、缓存、时长、关键路径、并行度）
- [x] 连线拐角对齐、共享通道与绕行障碍
- [x] 快照文件模式与演示模式
- [x] OmO 控制器、任务存储、流式捕获
- [x] Herdr pane 生命周期与 Node 探测
- [x] 安装器、构建、README
- [x] 单元测试
- [x] PTY 内实际渲染检查
- [x] 按键/缩放/动画/退出检查
- [x] 最终审查与交付

## 9. 验收标准

1. `bun run demo` 在当前终端进入全屏仪表盘；demo 持续动画时按 60 fps 运行，可用 `--fps N` 在 2-120 之间调整，宽屏静态视图至少 24 fps、窄屏降到 1 fps。
2. 120×40、90×30、70×24 三种尺寸下无横向溢出、无崩溃。
3. 运行中节点有 spinner/呼吸边框/流动边；完成时有 toast。
4. `←/→` 切 run，`Tab`/点击选节点，`↑↓` 平滑滚动，`Space` 折叠，`d` 详细模式，
   `f` 跟随，`s` 设置（主题/动画/语言），`?` 帮助，`q` 退出。
5. 切换语言后界面立即刷新；重启 viewer 后语言保持不变。
6. `--once --no-color --width 120 --height 40` 输出稳定、可断言。
7. 快照文件模式可被扩展写入并实时刷新；v1、v2、v3 都能读。
8. 选中 run 时显示运行汇总；token/成本/时长与节点详情对得上，缺失数据标注覆盖度。
9. `bun test`、`bun run build` 通过。

## 10. 验证方法

- 单元测试：拓扑、周期检测、演示时间轴、宽字符裁剪、渲染尺寸、
  中英文文案一致性、语言配置读写。
- PTY 实测：`bun src/viewer.mjs --demo` 在 140×42 的 PTY 中运行，
  用屏幕快照检查布局、颜色和动画；发送按键验证交互。
- 静态帧：`--once` 输出到文本，检查每行显示宽度和关键区块。
- 构建：`bun scripts/build.mjs` 使用 Bun transpiler 检查全部模块并生成 dist。
