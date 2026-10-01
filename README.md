# looonger-feishu-observer

looonger 的**飞书前端面插件**（独立仓库，第三方消费方）：把任务运行状态推送到飞书群，
并允许在飞书里给任务发**人类输入**。

> **只看运行状态，不看消息内容**：卡片展示三角色接力、队列、目标、占用与结局——
> 不转发 solver / strategist / pruner 的消息流正文、thinking、工具输入输出。

## 能力

| 能力 | 说明 |
| --- | --- |
| 流式状态卡片 | 飞书 CardKit 流式卡片（`streaming_mode`），全量文本更新、平台算增量打字机 |
| 状态与 TUI 同口径 | 角色 LIVE/HELD/IDLE、QUEUE pending/相位（⏸/▸/✓/✗）、GOAL/BOARD 计数、停滞标记、上下文占用——数据源与 `packages/tui` 右栏同一份 `TaskHandle` 快照 |
| 人类输入 | 飞书文本 → `handle.sendHumanInput()` → strategist 审查队列（与 TUI 输入同一条路） |
| 命令 | `/status` 立即刷新；`/stop` 两段式确认后 `requestStop()`；`/cancel` 取消；`/help` |
| 安全 | 发送者 open_id 白名单（**空 = 拒绝一切指令**，fail-closed）；chat 白名单可选 |
| 健壮性 | 飞书任何失败只降级（无卡片也有命令回复），**绝不冒泡到任务**；流式被关自动重开重推 |

## 快速开始

### 0. 一键授权（推荐先跑这个）

```bash
bun install
bun run setup
```

向导把「装应用」压到最短：**第 1 步控制台操作一次性人工**（飞书没有开放「创建应用」API，
这步省不掉，但只需做一次），**其余全自动**——脚本自动打开后台/授权页，你只需：
控制台勾清单 → 浏览器点一下「授权」→ 看着它把配置写好 → 去飞书群收测试卡。

| 向导步骤 | 做什么 | 谁做 |
| --- | --- | --- |
| 1/5 创建应用 | 建自建应用 / 加机器人 / 开 4 个权限 / 长连接事件 / 登记重定向 URL / **发布版本** | 人工（脚本自动打开后台 + 逐项清单） |
| 2/5 浏览器授权 | 起本地回调服务 + 自动打开授权链接 | 人工只在网页点「授权」 |
| 3/5 补齐配置 | 授权码 → user_access_token → **你的 open_id 自动进白名单** → 选推送目标：**私聊（只发给你自己，零群）或群**（群模式才拉群） | 全自动 |
| 4/5 写配置 | 写 `feishu.json`（600 权限，旧文件备份 `.bak`） | 全自动 |
| 5/5 联通性验证 | 往目标群发一张测试卡片 | 全自动 |

授权用到的 scope：`im:chat:readonly`（发现你的群）+ `im:chat.members:write_only`（拉机器人进群）
——控制台不开这两个权限，授权页会报 20027，向导会明确告诉你卡在哪。

> 拒绝授权 / 超时（3 分钟）/ state 不匹配都会干净退出并说明原因；重跑 `bun run setup` 即可。
> 换群、加白名单：重跑向导（未填项沿用旧值）。

### 1. （可选）手工配置

不想用向导就手工来。飞书侧仍需：创建企业自建应用 → 添加「机器人」能力 →
权限 `im:message`、`cardkit:card:write` → 事件订阅（**长连接**方式 + `im.message.receive_v1`）→
发布版本。

```bash
cp feishu.json.example feishu.json   # feishu.json 已在 .gitignore，不会提交
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appId` / `appSecret` | ✅（可被 env 覆盖） | — | 应用凭据；密钥也可放 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量 |
| `chatId` | ✅ | — | 状态卡片推送目标：群 `chat_id`（`oc_` 开头），或私聊模式填授权者 open_id（见下） |
| `receiveIdType` | — | `chat_id` | `chat_id` = 群；`open_id` = **私聊**（卡片只发给授权者本人，不需要任何群） |
| `allowedSenders` | — | `[]` | 可发人类输入/命令的 open_id 白名单；**空 = 全拒**（只推卡片） |
| `allowedChats` | — | `[]` | chat 白名单（空 = 只认发送者白名单） |
| `baseUrl` | — | `https://open.feishu.cn` | Lark 国际版改 `https://open.larksuite.com` |
| `flushMs` | — | `2000` | 卡片刷新间隔（脏标记 + 定时 drain；流式模式下不受 QPS 限制） |
| `queueTail` | — | `3` | 每队列展示最近 N 条（held 全留，与 TUI 一致） |
| `showBoard` | — | `true` | GOAL/BOARD 计数区 |
| `stopConfirmWindowMs` | — | `60000` | `/stop` 确认窗口 |

### 3. 挂到 looonger（两种装订，同一份观察者）

**A. 领域 manifest（`-d` 或配置文件 `domain` 段）**——本仓库自带 `looonger.json`：

```bash
bun run <looonger>/apps/cli/src/index.ts -d /path/to/looonger-feishu-observer -o "<目标>" -c <工作目录>
```

在 looonger 的 `looonger.json` 里写 `"domain": "/path/to/looonger-feishu-observer"` 即可常驻，
不用每次 `-d`（looonger ≥ 配置级 domain 支持；`-d` 显式优先）。

**B. 宿主级 frontends（自定义宿主）**：每个任务都挂，TUI 零改动：

```ts
import { createFeishuObserver, loadFeishuConfig } from "looonger-feishu-observer";

const config = await loadFeishuConfig("./feishu.json");
const client = createLooongerClient({ backend, frontends: [createFeishuFrontend({ config })] });
```

### 4. 飞书里怎么用

| 发送 | 行为 |
| --- | --- |
| 任意文本 | 人类输入（入 strategist 审查队列，回复「已入队 ✓」） |
| `/status` `/状态` | 立即刷新状态卡片 |
| `/stop` `/停止` | 请求停止（60s 内需确认） |
| `/stop confirm` `/确认` | 确认停止 → `requestStop()` |
| `/cancel` `/取消` | 取消待确认的停止 |
| `/help` `/帮助` | 命令表 |

群聊里 @机器人 后跟内容即可（`@_user_1` 占位符已自动剥离）。

## 卡片内容

```text
**找出内网入口并拿到 flag**            ← GOAL objective（截断）
`task-3f2a…`                          ← taskId
🟢STR idle · 🟡SOL 待放行 · ⚪PRN idle  ← 三角色接力（互斥：至多一个 live）
⚙️ Thinking 2m31s                      ← 活动 + 观测时长（非任务开始时刻）
⚠️ 停滞 bash ×12                       ← F-8 停滞事实（工具名 + 次数）
QUEUE
STR ⏸ 1  ▸ 审查  检查 pcap 解析结果…
SOL idle ✓ 指令  跑 scan.py（✓ = 已消费）
GOAL ● active
BOARD TODO 3/8 · IDEA 2 · MEM 5
12:04:31 · 事件 128 · 人类输入 2
```

收尾时卡片最后刷一次结局（`✅ 任务完成（task_completed）` / `⏹ 已停止（…）`）并关闭流式模式。

## 架构

```text
src/
  frontend.ts        TaskFrontend 装配：订阅（同步、回调不 await）+ 节流 flush + 命令路由 + dispose 收尾
  setup.ts          一键授权向导（bun run setup）：本地回调 + OAuth + 自动发现群/白名单 + 写配置 + 测试卡
  setup-lib.ts      向导纯函数件（授权链接/回调解析/scope）
  status-model.ts   纯函数状态机（与 TUI model.ts/sidebar.ts 逐条对齐）+ markdown 渲染——零 IO，可单测
  card.ts           卡片 JSON 2.0（streaming_mode / streaming_config / 单 markdown 元素）
  feishu-client.ts  传输层接口 + Lark 实现（CardKit REST + WSClient 长连接）
  commands.ts       命令解析（纯函数；未知斜杠命令不当人类输入）
  config.ts         feishu.json 加载/校验 + env 覆盖
```

四条实务纪律（对齐 looonger 领域观察者契约）：

1. **订阅回调绝不 await**——只搬运事实 + 打脏标记；飞书 IO 全部在 flush 定时器里；
2. **状态种子来自快照**（`queueSnapshot/goalSnapshot/boardSnapshot`），不靠事件补——
   `--resume` 恢复时 T1–T7 事件挂不上，快照口径自愈该盲区；
3. **黑名单事件只计数不收内容**：`message-*` / `tool-*` / `instruction-sent` 的正文绝不进状态
   （`message-delta` 只取 `parseMessageDelta().kind` 做活动分类）；
4. **降级不冒泡**：建卡失败 → 只有命令回复；更新失败 → 保持脏标记下轮重试；流式被关
   （`200850/300309`）→ 自动重开后同文重推。
5. **日志不闯屏**（与 looonger 库层同口径）：插件默认经 `@looonger/harness` 的 raw-output
   接管作用域写日志——真实宿主里全部收编进任务诊断日志 `<dataDir>/<taskId>.log.jsonl`，
   **永不上屏**；飞书 SDK 自带的 console logger（`[info]: …` 那一位）也被换成静默
   info/debug/trace + warn/error 收编。本地排障想强制上屏：`FEISHU_DEBUG=1`。
   排障入口：`grep feishu <dataDir>/<taskId>.log.jsonl`。

## 已知限制（如实声明）

- **观测时长**从观察者 attach 起算，不是任务开始时刻（resume 场景尤其如此）；真实时间线看账本；
- 消息里除 `text` 外的类型（图片/卡片/文件）忽略；
- 群消息依赖飞书「@机器人 才推送」或应用「获取群组全部消息」权限；
- 卡片实体 14 天有效、只能发送一次——长跑任务超期后需重启进程换新卡；
- 流式模式 10 分钟无开启动作会自动关（每 ≤`flushMs` 推一次，并已做重开容错）。

## 开发

```bash
bun install
bun run check     # tsc --noEmit + bun test（37 条）
bun run setup     # 一键授权向导
```

依赖说明：`looonger-sdk` 等四个包通过 `tsconfig.json` 的 `paths` 指向**同级目录的 looonger 仓库源码**
（bun 运行与 tsc 都吃 paths），无需发布/安装 looonger；仓库搬迁时同步改 `tsconfig.json`。
唯一真实 npm 依赖是 `@larksuiteoapi/node-sdk`（长连接；REST 走 `fetch`，方便替身测试）。

## License

MIT
