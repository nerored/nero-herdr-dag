# Herdr DAG Studio — 设计与实施计划

## 1. 产品定位

`herdr-dag-studio` 是一个面向 OmO workflow 的 **Herdr 侧栏 TUI**，参考
`jc01rho/omo-herdr-dag` 的“扩展采集 + 独立 viewer 读快照”架构，但重写展示层：

- 三栏仪表盘：运行/任务列表、DAG 画布、节点详情。
- 持续动画：运行呼吸色、spinner、边流动点、进度条微光、选中态过渡、
  footer 状态提示、平滑滚动（无过冲）。
- 更完整的细节：耗时、token、轮次、工具调用、重试、活动阶段、
  模型思考/回复摘录、最近日志（详细模式）、依赖、子任务、错误、运行级统计。
- 自适应布局：宽屏三栏；窄屏或紧凑 pane 使用 duty 单面布局，只显示 RUNS、CELLS、孤立任务存在时的 TASKS 列表和当前对象/详情，不渲染图谱；`S` 只在 112 列以上的宽屏生效。
- 演示模式：无需 OmO/Herdr，直接在当前终端用确定性假数据渲染并持续演化。
- 中英文界面：footer 右侧的 `⚙ 设置` 打开设置菜单，语言选择持久化到
  `~/.config/nero-herdr-dag/config.json`。
- 兼容参考插件的 v1 和 v2 快照；自己的扩展写出 v3 快照。

产品名：**Herdr DAG Studio**  
包名：`herdr-dag-studio`  
命令：`dag-studio`  
OmO 扩展入口：源码为 `extension.mjs`，安装后为 `<agent-dir>/extensions/omo-herdr-dag-studio.js`

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
│ ○ probe GPU runner │ │  ╰──────────────────╯   ╰──────────────────╯    │ │ subtasks: lint ✓  tests ⠹  │
│                    │ │  dependencies: build-api → build-ui → ...        │ │                            │
╰────────────────────╯ ╰──────────────────────────────────────────────────╯ ╰────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────────────────────────────
 ●run ✓done ×fail ◌wait  ? Help  m select  x clear  z focus · n/N nodes · 1-5 filter · / find   ● FOLLOW ON  60fps  ⚙ SETTINGS
```

### 布局断点

- `width >= 112`：三栏可用。侧栏 26–34 列，详情 34–44 列，中间为画布。
- `width < 112`：duty 单面布局，只显示 RUNS、CELLS、孤立任务存在时的 TASKS 列表和当前对象/详情，不渲染图谱；`S` 只在宽屏生效。
- `--pane` 启动时优先紧凑；pane 变宽/全屏后自动恢复导航栏，仍可用 `S` 手动切换。

### 面板

1. **Header**：渐变标题、当前 run、状态徽章、LIVE 脉搏点、时钟、会话短 ID。
2. **Sidebar**：RUNS 列表（状态、迷你进度条、计数）和 TASKS 列表；
   全局控件不放侧栏，图例和设置入口都在 footer。
3. **Graph**：拓扑分层节点卡片；运行中 spinner/呼吸边框；边流动点；
   选中发光；折叠节点仅保留标题行；底部显示依赖边列表。
4. **Details**：状态、耗时、agent/model、进度条、token 输入输出、
   轮次、工具调用、重试、活动阶段、模型思考/回复摘录、token 速率 sparkline、
   前驱/后继、子任务、错误；选中 run 时显示运行汇总（token、成本、缓存命中、
   墙钟/忙碌时长、关键路径、并行度与证据覆盖度）；详细模式追加最近日志。
5. **Footer**：左侧图例、可点击的 `? 帮助`、`m` 选区、`x` 清除、随焦点变化的提示（含 `z` 聚焦、`n/N` 节点、`1-5` 过滤、`/` 查找），右侧跟随状态与 fps，最右侧 `⚙ 设置` 入口；session 显示在 header，不在 footer。
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
  "sessionId": "0123456789abcdef01234567",
  "mode": "live",
  "connected": true,
  "updatedAt": "2026-11-09T…",
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

`mode` 为 `live`（连接的 controller 快照）、`saved`（断开连接的捕获）或 `demo`（内置演示）。`provenance` 记录来源（`controller`、`demo-engine`、`legacy-snapshot` 或 `viewer-placeholder`）、状态文件、任务存储根目录、采集时间和查看方式（`watch` 或 `once`）。`sources` 列出 controller 扫描的任务和 checkpoint 存储，以及各存储的计数、扫描时间和错误。

两个内置生产者写入的字段不同，viewer 必须容忍缺省：

| 字段 | controller (`src/controller.mjs`) | demo (`src/demo.mjs`) |
| --- | --- | --- |
| `updatedAt` | 每次保存写入的 ISO 时间 | 不写 |
| `language` | 不写，viewer 按 `en` 处理 | 固定写 `en` |
| `generatedAt` | 不写，viewer 回退到 `updatedAt`（与 `provenance.capturedAt` 是同一个保存时钟） | 与 `provenance.capturedAt` 同源的引擎时钟 |
| `sources` | 写扫描计数 | 不写 |
| `demo` / `provenance.demo` | 不写 | 写 `cycle`、`phase`、`cycleMs` |
| `provenance.statePath` / `provenance.taskStateDir` | 写 | 不写 |

viewer 解析 `generatedAt` 的顺序是：`generatedAt`、`updatedAt`、`generated_at`、`provenance.capturedAt`，最后只在已连接的 live 快照上取当前时间。viewer 会根据记录推导每个字段的来源（`recorded`、`derived`、`simulated`、`unavailable` 或 `unknown`）。

### 视图专用孤立任务 run

`src/orphan-run.mjs` 在会话可见快照边界生成一个只用于显示的 run，id 为
`orphan:tasks`（与真实 run 冲突时追加 `#2`、`#3`），并排在所有真实 run 之后。
它收集没有被任何可见 run 节点关联的根任务；隐藏项先过滤，真实 run 的索引和
默认选择不变。

边界固定为两层：`viewer.snapshot` 和绘制帧包含该 run，`viewer.fullSnapshot`、
状态文件、v1/v2/v3 快照、CLI 参数与公开 viewer 键保持原样。`--once` 与 `--pane`
使用同一份可见快照，因此输出包含该分组。没有可见孤立任务时，可见快照与原始
快照是同一个对象，帧与直接渲染一致。

该 run 的图谱是扁平且零边的：每个成员一个显示节点，节点 id 等于任务 id，状态
取自任务状态，证据从任务继承，绝不生成合成根节点或依赖边。显示节点上限为
4,096；完整成员、`memberTaskIds`、统计和 TASKS 范围不受上限影响，溢出数量通过
`omittedNodes` 单独报告。run 名称、徽标、切换器行和 TASKS 范围都使用本地化文案
（英文 `UNATTACHED TASKS` / `unattached`，中文 `未归属任务` / `未归属`）。

选择该 run 会显示 run 概览和扁平图；点击显示节点只把该节点作为查看对象，不会
让任务变成已关联。TASKS 选择保持未关联（`no node`），即使焦点移到 RUNS 或
CELLS。虚拟节点不可折叠，恢复视图时也会丢弃该 run id 的旧折叠键；清除和隐藏
只作用于成员任务，不写入虚拟 run id。

演示数据的原始快照仍为 4 个 run；运行中的 demo 在可见快照末尾增加未归属分组。

## 7. 模块地图

```text
bin/dag-studio.mjs        CLI: demo / view / install / uninstall / --help / --version（-h、-v 为别名）
extension.mjs             OmO 生命周期、事件订阅、/dag-studio
src/model.mjs             快照 v1/v2/v3 规范化、模式与字段来源、运行排序、拓扑分层
src/orphan-run.mjs        可见根孤立任务的视图专用 run 投影（追加末位、扁平零边、显示上限）
src/normalize.mjs         宿主值原语（文本、数字、整数、ISO 时间、字节长度、已定义字段）
src/evidence.mjs          任务/运行证据字段的统一规范化（回复、错误、重试、turn、run_stats）
src/task-data.mjs         任务存储读取、合并、父子关系
src/dir-watch.mjs         惰性创建目录的监听封装：跟随祖先创建、重新挂载、失效退避重试
src/run-summary.mjs       运行级聚合（token/成本/缓存/时长/关键路径/并行度）
src/demo.mjs              周期性假数据引擎
src/records.mjs           记录文件的有界读取、条目元数据与相对显示路径
src/viewer-snapshot.mjs   状态文件有界读取、快照上限校验、读取失败占位与证据、会话标识
src/text.mjs              grapheme、宽字符、fit/fitTail/wrap
src/theme.mjs             调色板、truecolor/256 色、颜色插值、明暗外观探测
src/canvas.mjs            单元格画布、边框、裁剪、ANSI 输出
src/frame-primitives.mjs  单帧单元格缓冲、面板/药丸/滚动条/详情行与指标格式化
src/graph.mjs             DAG 布局、线网、流动点
src/i18n.mjs              英文/中文文案表与插值
src/render.mjs            组装布局、侧栏、图谱与详情外壳，导出 renderApp
src/render-view.mjs       纯视图辅助：布局几何、列表/指针命中、新鲜度标签、选择与记录解析、导航再导出
src/render-panels.mjs     共享进度块与空状态/来源健康/来源面板
src/render-chrome.mjs     header 品牌/面包屑/状态与 footer 图例/提示/设置入口
src/render-duty.mjs       宽屏 duty 面板与窄屏 RUNS/CELLS/TASKS/DUTY 界面
src/render-subject.mjs    节点/任务对象构建与宽屏详情正文
src/render-summary.mjs    指标卡、run 摘要与警告
src/render-diagnosis.mjs  诊断卡、错误来源与完整原因
src/render-overlays.mjs   命令面板、切换器、tour、帮助、设置浮层与点击区域失效
src/view-model.mjs        编排与渲染器接缝：快照/UI 状态/上一帧、选择/焦点/折叠/滚动/指针
src/viewer-session.mjs    快照生命周期、状态迁移、选择/导航命令与 UI 字段
src/viewer-input.mjs      按键/鼠标/模态分发与指针命中解析
src/viewer-selection.mjs  点击、按键、切换器行和 follow 共用的选择 reducer
src/viewer-keymap.mjs     按键拼写与移动归一化、有序的模态/全局按键表
src/scroll.mjs            滚动意图、区域命中、滚动条几何与指数缓动
src/mouse.mjs             SGR/X10 鼠标事件解析
src/view-state.mjs        视图偏好 sidecar、112 列布局断点、切换器选择
src/commands.mjs          命令面板条目、标签与查询过滤
src/cockpit.mjs           图谱过滤、过滤计数、聚焦子图与节点步进、失败/阻塞分类
src/bounded-cache.mjs     有界 LRU 缓存与去重集合，达到上限时淘汰最久未用项
src/derived-cache.mjs     按快照/run/task 身份记忆化逐帧派生（navTasks、runStats、runSummary 等）
src/viewer.mjs            选项/依赖接线、draw/main、公共 API 与 CLI
src/viewer-source.mjs     状态文件有界读取、监听安装与退避重试
src/viewer-runtime.mjs    终端初始化/恢复、帧节奏与定时器、pager、关闭顺序
src/controller.mjs        事件串行队列、快照写入、pane 生命周期
src/omo.mjs               OmO agent 目录、project key、主题与明暗外观
src/config.mjs            语言/主题配置读取与串行原子保存（~/.config/nero-herdr-dag/config.json）、STALE 阈值
src/env.mjs               所有环境变量的单一解析入口（配置、状态、任务存储、runtime、herdr）
src/herdr.mjs             herdr pane CLI 封装
src/layout.mjs            安装代际目录与 current.json 指针路径（安装器与扩展共用）
src/runtime.mjs           Bun 1.4+ / Node 24+ 探测
src/storage.mjs           原子 JSON 读写
src/retention.mjs         过期快照清理
src/stream-tap.mjs        子任务流式活动捕获
src/todo-title.mjs        OmO TODO 事件到 run 标题的匹配
src/diagnosis.mjs         失败/阻塞诊断模型与可复制证据包
src/clipboard.mjs         OSC52/pager 证据复制，诊断与路径函数的兼容再导出
src/safe-path.mjs         绝对路径校验、根目录内 JSON 记录的安全打开
scripts/install.mjs       分代安装
scripts/install-lib.mjs   安装/卸载共享参数解析、布局检查与文件系统守卫
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
