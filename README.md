# looonger-feishu-observer

looonger 的**飞书前端面插件**（独立仓库，第三方消费方）：把任务运行状态推送到飞书群，
并允许在飞书里给任务发**人类输入**。

> **只看运行状态，不看消息内容**：卡片展示三角色接力、队列、目标、占用与结局——
> 不转发 solver / strategist / pruner 的消息流正文、thinking、工具输入输出。

## 能力

| 能力 | 说明 |
| --- | --- |
| 流式状态卡片 | 飞书 CardKit 流式卡片（`streaming_mode`），**按段局部刷新**（每次只推内容变化的段）、平台算增量打字机 |
| 状态与 TUI 同口径 | 角色 live/held/idle、QUEUE 相位（held/inbox/seen/cleared）、GOAL/BOARD 计数、停滞标记、上下文占用——数据源与 `packages/tui` 右栏同一份 `TaskHandle` 快照 |
| 人类输入 | 飞书文本 → `handle.sendHumanInput()` → strategist 审查队列（与 TUI 输入同一条路） |
| 命令 | `/status` 立即刷新；`/stop` 两段式确认后 `requestStop()`；`/cancel` 取消；`/help` |
| 安全 | 发送者 open_id 白名单（**空 = 拒绝一切指令**，fail-closed）；chat 白名单可选 |
| 健壮性 | 飞书任何失败只降级（无卡片也有命令回复），**绝不冒泡到任务**；流式被关自动重开重推；单段更新失败只重试该段，卡片不整块消失 |

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
| `queueTail` | — | `6` | 每队列展示最近 N 条（held 全留；比 TUI 侧栏的 3 宽，卡片放得下） |
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
import { createFeishuFrontend, loadFeishuConfig } from "looonger-feishu-observer";

const config = await loadFeishuConfig("./feishu.json");
const client = createLooongerClient({ backend, frontends: [createFeishuFrontend({ config })] });
```

### 4. 飞书里怎么用

| 发送 | 行为 |
| --- | --- |
| 任意文本 | 人类输入（入 strategist 审查队列，回复「已入队」） |
| `/status` `/状态` | 立即刷新状态卡片 |
| `/stop` `/停止` | 请求停止（60s 内需确认） |
| `/stop confirm` `/确认` | 确认停止 → `requestStop()` |
| `/cancel` `/取消` | 取消待确认的停止 |
| `/help` `/帮助` | 命令表 |

群聊里 @机器人 后跟内容即可（`@_user_1` 占位符已自动剥离）。

## 卡片内容

```text
### SOLVER · saying                        ← 最大字号：此刻谁在干活（主色只给这一处）

turn 3 · claude-sonnet-4-5 · 2:20          ← 用什么模型、观察多久了
4 calls · 1 err · last Edit                ← 健康：工具计数 / 报错 / 停滞 / 重试
queues STRATEGIST 1 · SOLVER 3             ← 积压与闸门（压缩期标 frozen）

conversation                                ← 他们相互说了什么（按时间顺序）
human ─▶ STRATEGIST+SOLVER  objective  修复 resume 事件窗口只回 0 条的状态漂移   inbox
STRATEGIST ─▶ SOLVER  prompt   先复现：repro-resume-blank.mjs 两连跑对比状态   seen
human ─▶ SOLVER  input  压缩前先把 goal note 更新为「盲区已复现」     seen

context                                     ← 压缩健康度
SOLVER █████░░░░░ 96k/200k (48.2%)   room left
STRATEGIST █████████░ 184k/200k (92.2%)  near limit

progress                                    ← 任务推进到哪了
goal blocked
solver 让路 todo_done：TODO-3 完成，等审查放行
todos 4/5 · ideas 2 · mem 3
doing 「修 revision 起点取数」

15:08:16 · human ×1
```

只放**观察 looonger 运行状态所需的信息**：谁在干活、用什么、健康吗、积压多少、
他们刚说了什么、上下文会不会炸、任务推到哪了。事件数/速率这类观察者遥测不上卡片。

设计口径：

- **配色克制**：默认全中性，只有需要注意的状态才上色。
  `blue` = 唯一主色，只给「此刻握着回合的那个人」和「新到待收」；
  `orange` = 需要留神（held / 重试 / 上下文过半）；
  `red` = 出问题了（报错 / 停滞 / 目标被堵 / 逼近阈值）；
  `green` = 只在终局成功用一次。其余一律 `neutral`。
- **不用 emoji**：角色用文本代号（`human` / `STRATEGIST` / `SOLVER` / `PRUNER`），
  相位用单词（`held` / `inbox` / `seen` / `cleared`），箭头用 `─▶`。
  上下文条「已用上色、未用中性」——宽裕时整条是灰的。
- **conversation 是核心**：按时间顺序列出他们实际说的话，`来路 ─▶ 去路　标签　原话　相位`。
  方向由 kind + 落点队列决定（`QUEUE_KINDS`：`instruction` 是 STRATEGIST→SOLVER、
  `review` 是 SOLVER→STRATEGIST、`objective`/`input` 是人发的）；同一句话发给两个角色
  合并成 `human ─▶ STRATEGIST+SOLVER`。条数上限 6 条，**单条原话全文展示、不截断**
  （压掉换行只为单行排版；长文本交给飞书自然换行）。顺序取 id 里盖的追加序号
  （core `nextQueueMessageId`），解析不了才退化成索引交织。
- **queues 行**替代了早期的接力图：`held` 条数 = 闸门堵着几条，
  压缩期间标 `frozen`（`RoleTurn.frozen()`：一切编排输入无动作，队列投不出去）。
- **分段局部刷新**（卡片不会整块消失的关键）：正文 = 5 个 markdown 段
  （`status_scene` / `status_conversation` / `status_context` / `status_progress` /
  `status_footer`），一段一个 `element_id`。每次 flush 只推**内容变化的段**——没变的段
  不占 sequence、不触发平台重绘（时钟段每拍都变，顺带证明卡片活着）；单段更新失败
  只进重试队列下轮重推，其他段照常上屏。某一段的问题（长文本、特殊字符、网络抖动）
  被关在段里，再也不会把整块正文带没。
- 词汇与 looonger 本身一致：turn / prompt / correction / follow-up / review /
  held / inbox / seen / cleared / frozen。
- 不用表格：格子窄、每表最多 5 行，会把内容切成看不懂的碎片。

收尾时卡片最后刷一次结局（`task completed (…)` / `stopped (…)`）并关闭流式模式。

### 本地预览（不连飞书）

两份 mock（同一条数据源 `scripts/mock-data.ts`，驱动真实的 `ingestStatus` / `renderStatusMarkdown`，不掺假状态）：

```bash
bun run preview        # 静态三态打印：流式中 / 审查闸+压缩中 / 完成（附 CardKit 建卡请求体）
bun run preview:live   # 实时回放：http://localhost:8791 —— 卡片按 flush 2s（虚拟）按段局部推送，
                       # 事件流 + CardKit API 日志同步滚；可暂停 / 1×·4×·16× / 跳到三个关键态
```

## 架构

```text
src/
  frontend.ts        TaskFrontend 装配：订阅（同步、回调不 await）+ 节流 flush + 命令路由 + dispose 收尾
  setup.ts          一键授权向导（bun run setup）：本地回调 + OAuth + 自动发现群/白名单 + 写配置 + 测试卡
  setup-lib.ts      向导纯函数件（授权链接/回调解析/scope）
  status-model.ts   纯函数状态机（与 TUI model.ts/sidebar.ts 逐条对齐）+ markdown 渲染——零 IO，可单测
  card.ts           卡片 JSON 2.0（streaming_mode / streaming_config / 按段多 markdown 元素）
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
- 流式模式 10 分钟无开启动作会自动关（每 ≤`flushMs` 推一次，并已做重开容错）；
- 对话原话全文展示（条数封 6 条）——极端长文本可能顶到飞书卡片 30KB 上限，
  届时该段更新失败并重试、其他段不受影响（不会拖垮整张卡）。

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
