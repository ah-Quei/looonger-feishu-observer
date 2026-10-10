/** 状态模型（纯函数，零 IO）：任务事实 → 飞书卡片状态。
 *
 *  口径与 looonger TUI **逐条对齐**（`packages/tui/src/model.ts` 的 busy/role 状态机 +
 *  `sidebar.ts` 的 QUEUE/GOAL/BOARD 渲染），差异只在载体（markdown 文本 vs ANSI 面板）。
 *
 *  **明确不收**：message-* 正文、thinking、tool 输入/输出、instruction 正文——
 *  只看运行状态。message-delta 只用来给活动分类（thinking/saying/work），不读正文。
 */

import type {
  ActiveRole,
  BoardSnapshot,
  LooongerEvent,
  LooongerGoal,
  QueueMessage,
  QueuePhase,
  QueueSnapshot,
  QueueView,
  TaskOutcome,
} from "looonger-sdk";
import { parseMessageDelta } from "looonger-sdk";

// ============ 状态 ============

export type StatusActivity = "working" | "thinking" | "saying";

/** ingest 内部用的可写形态（对外仍是只读快照语义）。 */
type MutableStatus = { -readonly [K in keyof StatusState]: StatusState[K] };

export interface RoleChip {
  readonly role: ActiveRole;
  /** live = 当前有模型活动的角色（互斥：至多一个）；held = solver 被审查闸按住。 */
  readonly live: boolean;
  readonly held: boolean;
  /** 副文案一行（模型/思考档/让路原因/压缩原因；无则 undefined）。 */
  readonly detail: string | undefined;
}

export interface StatusState {
  readonly taskId: string;
  readonly objective: string;
  /** 最后一条带角色的事实所在角色（TUI 同一把尺子：「在场」角色）。 */
  readonly currentRole: ActiveRole | undefined;
  readonly busy: boolean;
  readonly compacting: boolean;
  readonly compactDetail: string | undefined;
  readonly solverHeld: boolean;
  readonly activity: StatusActivity | undefined;
  readonly stall: { readonly toolName: string; readonly repeats: number } | undefined;
  readonly lastYield: string | undefined;
  readonly humanInputs: number;
  readonly eventCount: number;
  /** 观察者 attach 时刻（**不是**任务开始时刻——resume 的盲区见 README）。 */
  readonly attachedAtMs: number;
  /** 上下文占用（harness 事实透传：tokens/percent 可为 null）。
   *  `label` 直接展示；`pct` 给渲染层上色/拉条（null = 平台没报百分比）。 */
  readonly ctx: Partial<Record<ActiveRole, { readonly label: string; readonly pct: number | null }>>;
  /** 各角色上下文占用峰值（压缩回收后「曾 92%」可观察——只看过多少水，不看正文）。 */
  readonly ctxPeak: Partial<Record<ActiveRole, number>>;
  /** 工具活动（只记账：次数/错误数/当前·上一个工具名——输入输出一律不读）。 */
  readonly tools: {
    readonly calls: number;
    readonly errors: number;
    readonly active: string | undefined;
    readonly last: string | undefined;
  };
  /** 重试中（run-retrying 的 attempt/max/delay；error 正文不进状态——那是日志的事）。 */
  readonly retry: { readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number } | undefined;
  /** 最近一次 turn-started 的回合号（比 run 细一度）。 */
  readonly turn: number;
  /** 各角色最近一次 model-changed 的模型名（换模型可观测）。 */
  readonly models: Partial<Record<ActiveRole, string>>;
}

/** render 需要的快照面（每次 flush 现取——事件只负责打脏标记）。 */
export interface StatusSnapshots {
  readonly queues: QueueSnapshot | undefined;
  readonly goal: LooongerGoal | undefined;
  readonly board: BoardSnapshot | undefined;
  readonly outcome: TaskOutcome | undefined;
}

/** seed 需要的只读面（TaskHandle 的形状子集——纯函数测试用替身即可）。 */
export interface StatusSource {
  readonly taskId: string;
  goalSnapshot(): LooongerGoal | undefined;
  queueSnapshot(): QueueSnapshot;
  boardSnapshot(): BoardSnapshot | undefined;
  /** 事件窗口（seed 只从中取 task-start-requested 的 objective）。 */
  fetchWindow(): readonly LooongerEvent[];
}

// ============ seed（resume/首启都先按快照播种，不靠事件补） ============

export function seedStatus(source: StatusSource, nowMs: number): StatusState {
  const goal = source.goalSnapshot();
  let objective = goal?.objective ?? "";
  if (objective.length === 0) {
    // 未 seed goal 的新任务（或旧账本）：objective 在 task-start-requested 里
    for (const event of source.fetchWindow()) {
      if (event.type === "task-start-requested") {
        objective = event.task.objective;
        break;
      }
    }
  }
  return {
    taskId: source.taskId,
    objective,
    currentRole: undefined,
    busy: false,
    compacting: false,
    compactDetail: undefined,
    solverHeld: false,
    activity: undefined,
    stall: undefined,
    lastYield: undefined,
    humanInputs: 0,
    eventCount: 0,
    attachedAtMs: nowMs,
    ctx: {},
    ctxPeak: {},
    tools: { calls: 0, errors: 0, active: undefined, last: undefined },
    retry: undefined,
    turn: 0,
    models: {},
  };
}

// ============ ingest（与 TUI model.ts 同构的状态机；不含任何正文读取） ============

export function ingestStatus(state: StatusState, event: LooongerEvent): StatusState {
  const next: MutableStatus = { ...state, eventCount: state.eventCount + 1 };

  // 「在场」角色：最后一条带角色的事实（TUI 同一把尺子）
  if (event.role !== null && event.role !== next.currentRole) {
    next.currentRole = event.role;
    next.busy = true;
  }
  // 进入运行：TUI 同款三触发（+ message-consumed{strategist}）
  if (
    event.type === "run-started" ||
    (event.type === "message-consumed" && event.role === "strategist")
  ) {
    next.busy = true;
  }
  // 活动分类：只取 kind，不读正文（parseMessageDelta 返回 {kind, delta}，delta 丢弃）
  if (event.type === "message-delta") {
    next.busy = true;
    const parsed = parseMessageDelta(event.delta);
    if (parsed !== undefined) {
      next.activity = parsed.kind === "thinking" ? "thinking" : "saying";
    }
  }
  // 离开运行
  if (event.type === "run-settled" || event.type === "run-failed") {
    next.busy = false;
    next.activity = undefined;
  }
  // solver 让路：记住原因（芯片副文案），下一轮 solver run-started 清掉
  if (event.type === "solver-stopped") {
    next.busy = false;
    next.activity = undefined;
    next.lastYield = event.reason;
  }
  // 压缩事务：pruner 上场（互斥的另一半）
  if (event.type === "compaction-started") {
    next.busy = true;
    next.compacting = true;
    next.compactDetail = event.reason;
  }
  if (event.type === "compaction-succeeded") {
    next.busy = false;
    next.compacting = false;
    next.compactDetail = undefined;
  }
  // 审查闸：solver 被按住，等 strategist 放行
  if (event.type === "review-requested") {
    next.solverHeld = true;
  }
  if (event.type === "run-started" && event.role === "solver") {
    next.solverHeld = false;
    next.lastYield = undefined;
    next.stall = undefined;
  }
  // 终局：全部落停
  if (event.type === "session-stopped") {
    next.busy = false;
    next.compacting = false;
    next.compactDetail = undefined;
    next.solverHeld = false;
    next.activity = undefined;
  }
  // 停滞（F-8 事实透传；payload 只有工具名与次数——不是工具输出）
  if (event.type === "stall-detected") {
    next.stall = {
      toolName: event.payload.toolName ?? "未知工具",
      repeats: event.payload.repeats,
    };
  }
  // 上下文占用（harness 事实透传：tokens/percent 可为 null）
  if (event.type === "context-usage") {
    const { tokens, contextWindow, percent } = event.usage;
    const used = tokens === null ? "?" : formatTokens(tokens);
    const window = contextWindow > 0 ? formatTokens(contextWindow) : "?";
    const pctLabel = percent === null ? "" : ` (${formatPercent(percent)})`;
    next.ctx = { ...next.ctx, [event.role]: { pct: percent, label: `${used}/${window}${pctLabel}` } };
    if (percent !== null) {
      const peak = next.ctxPeak[event.role] ?? 0;
      next.ctxPeak = { ...next.ctxPeak, [event.role]: Math.max(peak, percent) };
    }
  }
  // 工具活动：只读 toolName / isError，输入输出一律不读（黑名单同 message-* 纪律）
  if (event.type === "tool-started") {
    next.tools = { ...next.tools, active: event.toolName };
  }
  if (event.type === "tool-settled") {
    next.tools = {
      calls: next.tools.calls + 1,
      errors: next.tools.errors + (event.isError ? 1 : 0),
      active: undefined,
      last: event.toolName,
    };
  }
  // 重试：attempt/max/delay 可见（瞬态：下一轮 run 生命周期事件即清）
  if (event.type === "run-retrying") {
    next.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs };
  }
  if (event.type === "run-started" || event.type === "run-settled" || event.type === "run-failed") {
    next.retry = undefined;
  }
  // 回合号（turn 级粒度：比 run 细一度，长任务看进展用）
  if (event.type === "turn-started") {
    next.turn = event.turnIndex;
  }
  // 模型（per-role：换模型/降级可观测；provider 不进卡片，只有 model 名）
  if (event.type === "model-changed") {
    next.models = { ...next.models, [event.role]: event.model.model };
  }
  // 人类输入计数（正文只在队列区可见一次——那是用户自己发的东西）
  if (event.type === "human-input-received") {
    next.humanInputs = next.humanInputs + 1;
  }
  return next;
}

// ============ 派生视图 ============

/** 三角色芯片（互斥：至多一个 live；compacting 时 pruner 上场）。 */
export function roleChips(state: StatusState): readonly RoleChip[] {
  let live: ActiveRole | undefined;
  if (state.compacting) live = "pruner";
  else if (state.busy) live = state.currentRole;
  const roles: readonly ActiveRole[] = ["strategist", "solver", "pruner"];
  return roles.map((role) => {
    const isLive = live === role;
    const held = role === "solver" && !state.compacting && live === "strategist" && state.solverHeld;
    let detail: string | undefined;
    if (held) detail = "待放行";
    else if (state.compacting && role === "pruner")
      detail = `压缩中（${state.compactDetail ?? "threshold"}）`;
    else if (role === "solver" && !isLive && state.lastYield !== undefined)
      detail = `让路 ${state.lastYield}`;
    else if (isLive) detail = state.activity === undefined ? "live" : state.activity;
    else detail = "idle";
    if (role === "pruner" && !state.compacting && !isLive) detail = "idle";
    return { role, live: isLive, held, detail };
  });
}

// ============ 渲染（markdown；飞书卡片 2.0 的 markdown 组件） ============

/**
 * 配色：**默认全中性，只有需要注意的状态才上色**。
 *
 *  不用绿油油/紫莹莹的彩虹——那是仪表盘皮肤，不是工具。整套只有：
 *  - `neutral`：次要信息（idle / 已消费 / 标签 / 尾行）；
 *  - `blue`：唯一主色——**此刻握着回合的那个人**，以及「新到待收」；
 *  - `orange`：需要留神（held 压着 / 重试中 / 上下文过半）；
 *  - `red`：出问题了（工具报错 / 停滞 / 目标被堵 / 上下文逼近阈值）；
 *  - `green`：只在终局成功用一次。
 *  飞书 `<font color>` 枚举（官方文档已核实）含以上全部取值。
 */
const INK = "neutral";
const ACCENT = "blue";
const WARN = "orange";
const DANGER = "red";
const OK = "green";

/** 交互图里的参与者（文本代号，不用 emoji——emoji 一多就花）。 */
type Actor = "human" | ActiveRole;

const ACTOR_TOKEN: Record<Actor, string> = {
  human: "human",
  strategist: "STRATEGIST",
  solver: "SOLVER",
  pruner: "PRUNER",
};

/**
 * 接力图（relay）——**回合作者 `RoleTurn` 的可视化**（core 唯一出处）：
 *
 *  - 回合是**接力棒**，同时只有一个角色持有（`currentRole` 是唯一写点）；
 *  - human 打字 → 挂起 solver（闸门）→ 消息进 strategist 队列（`human_input`）；
 *  - strategist 收尾 → 交棒给 solver（`strategist_settled`）；
 *  - solver 收尾 / 工具送审 → 回 strategist 审查（`solver_settled` / `tool_review`）；
 *  - 压缩事务 → 确认 pruner 后**冻结一切编排**（`frozen`），跑完回 strategist。
 *
 *  画成立即往下流的竖轨：**标签写在轨线上**（自包含行），不依赖跨行列对齐——
 *  emoji 是双宽，横向对齐必歪（实测过：横向回环的 └──── 完全对不上）。
 *  `← turn` 标出接力棒此刻在谁手里（主色只给这一处）。
 */
/**
 * 队列一行：深度 + 闸门（`held` 压着几条）+ 压缩期冻结。
 *
 *  接力图撤了——heading 已经说清「谁握着回合」，图是重复的。图里**独有**的信息只剩
 *  队列深度（闸门堵没堵）和 `frozen`（`RoleTurn.frozen()`：压缩期间一切编排输入无动作，
 *  队列投不出去），压成一行就够。
 */
function queueLine(state: StatusState, snap: StatusSnapshots): string | undefined {
  if (snap.queues === undefined) return undefined;
  const parts: string[] = [];
  if (state.compacting) parts.push(`<font color='${ACCENT}'>frozen</font>`);
  for (const role of LANE_ROLES) {
    const view = snap.queues[role];
    if (view === undefined || view.history.length === 0) continue;
    const held = countHeld(view);
    const mark = held > 0 ? ` <font color='${WARN}'>(${held} held)</font>` : "";
    parts.push(`${ACTOR_TOKEN[role]} ${view.history.length}${mark}`);
  }
  if (parts.length === 0) return undefined;
  return `queues  ${parts.join(" · ")}`;
}

/** 两条 lane（上下文面板与队列面板共用一套列头；队列快照只有这两个 key）。 */
const LANE_ROLES = ["strategist", "solver"] as const;

function countHeld(view: QueueView): number {
  return view.history.filter((m) => phaseOf(view, m) === "held").length;
}

function phaseOf(view: QueueView, message: QueueMessage): QueuePhase {
  const stamped = view.phases?.[message.id];
  if (stamped !== undefined) return stamped;
  return view.pending.some((item) => item.id === message.id) ? "held" : "inbox";
}

/** 一条交互：从哪来 → 去哪（kind 定来路，落点队列定去路）。 */
function hopOf(message: QueueMessage): { readonly from: Actor; readonly to: Actor } {
  switch (message.kind) {
    case "review":
      return { from: "solver", to: "strategist" };
    case "instruction":
      return { from: "strategist", to: "solver" };
    default:
      return { from: "human", to: message.target === "solver" ? "solver" : "strategist" };
  }
}

/** 相位 → 颜色（只有「待审」和「新到」值得被看见，其余沉到中性）。 */
function phaseColor(phase: QueuePhase): string {
  if (phase === "held") return WARN;
  if (phase === "inbox") return ACCENT;
  return INK;
}

/** kind → 短标签；instruction 按通道分（`DELIVERY_LABELS` 同义：steer=Correction、followUp=Follow-up）。 */
function kindLabel(message: QueueMessage): string {
  switch (message.kind) {
    case "objective":
      return "objective";
    case "review":
      return "review";
    case "human-input":
      return "input";
    case "instruction":
      if (message.mode === "steer") return "correction";
      if (message.mode === "followUp") return "follow-up";
      return "prompt";
  }
}

const CTX_ROLES: readonly ActiveRole[] = ["strategist", "solver", "pruner"];

/** 「对话」最多画几条：够看出几个来回（人→策略→求解→策略），又不把卡片变成流水账。
 *  封的是**条数**；单条原话全文不截断（见 conversationRow）。 */
const CONVERSATION_CAP = 6;

function visibleQueueMessages(view: QueueView, tail: number): readonly QueueMessage[] {
  const held = view.history.filter((m) => phaseOf(view, m) === "held");
  const rest = view.history.filter((m) => {
    const phase = phaseOf(view, m);
    return phase === "inbox" || phase === "seen" || phase === "cleared";
  });
  const keep = new Set([...held, ...rest.slice(-tail)].map((m) => m.id));
  return view.history.filter((m) => keep.has(m.id));
}

/** 时间线上的一条：消息 + 它所在的 lane（相位要从自己的队列读）。 */
interface FlowEntry {
  readonly message: QueueMessage;
  readonly view: QueueView;
}

/**
 * 两条 lane 合成一条时间线。
 *  —— 队列消息不带显式时间戳，但 `history` 就是追加顺序，而 id 里盖着追加序号
 *     （`q-<base36 时刻>-<序号>`，见 core `nextQueueMessageId`）：能解析就全局排真序，
 *     解析不了（外部/存档数据）就退化成按索引交织，绝不把后发生的画到上面。 */
function flowEntries(snap: StatusSnapshots, tail: number): readonly FlowEntry[] {
  if (snap.queues === undefined) return [];
  const build = (view: QueueView | undefined): readonly FlowEntry[] =>
    view === undefined ? [] : visibleQueueMessages(view, tail).map((message) => ({ message, view }));
  const str = build(snap.queues.strategist);
  const sol = build(snap.queues.solver);
  const all = [...str, ...sol];
  if (all.length > 0 && all.every((entry) => /^q-[0-9a-z]+-[0-9a-z]+$/.test(entry.message.id))) {
    return [...all].sort((a, b) => appendKey(a.message) - appendKey(b.message));
  }
  const merged: FlowEntry[] = [];
  for (let i = 0; i < Math.max(str.length, sol.length); i += 1) {
    const a = str[i];
    const b = sol[i];
    if (a !== undefined) merged.push(a);
    if (b !== undefined) merged.push(b);
  }
  return merged;
}

function appendKey(message: QueueMessage): number {
  const m = /^q-([0-9a-z]+)-([0-9a-z]+)$/.exec(message.id);
  if (m === null) return 0;
  const at = Number.parseInt(m[1] ?? "", 36);
  const seq = Number.parseInt(m[2] ?? "", 36);
  if (!Number.isFinite(at) || !Number.isFinite(seq)) return 0;
  return at * 1_000_000 + seq;
}

/** 一行对话：`来路 ─▶ 去路　标签　原话　相位`——**原话全文，不截断**：
 *  对话是卡片的核心信息，40 字省略会把指令/审查切得看不懂；压掉换行只为单行排版，
 *  长文本交给飞书自然换行。卡片 30KB 上限由 CONVERSATION_CAP 的条数封顶兜底——
 *  真超限也只是该段更新失败重试，其他段不受影响（见 frontend 的局部刷新）。 */
interface ConversationRow {
  readonly from: Actor;
  readonly to: readonly Actor[];
  readonly kind: string;
  readonly content: string;
  readonly phase: QueuePhase;
}

/** 同一句话发给两个角色（任务目标同时进两条队列）→ 合并成一行 `human ─▶ STRATEGIST+SOLVER`，不说两遍。 */
function groupConversation(entries: readonly FlowEntry[]): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const entry of entries) {
    const { from, to } = hopOf(entry.message);
    const last = rows[rows.length - 1];
    if (last !== undefined && last.from === from && last.content === entry.message.content) {
      rows[rows.length - 1] = { ...last, to: [...last.to, to], phase: phaseOf(entry.view, entry.message) };
      continue;
    }
    rows.push({
      from,
      to: [to],
      kind: kindLabel(entry.message),
      content: entry.message.content,
      phase: phaseOf(entry.view, entry.message),
    });
  }
  return rows;
}

function conversationRow(row: ConversationRow): string {
  const to = row.to.map((actor) => ACTOR_TOKEN[actor]).join("+");
  return `${ACTOR_TOKEN[row.from]} ─▶ ${to}　${row.kind}　${flat(row.content)}　<font color='${phaseColor(row.phase)}'>${row.phase}</font>`;
}

/** 单行化：压掉首尾空白与内部连续空白——**不截断内容**（truncate 才截）。 */
function flat(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncate(text: string, max: number): string {
  const oneLine = flat(text);
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}

function clock(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 百分比（整数省略小数；如 9.7% / 10%——与 TUI footer 同一把尺子）。 */
function formatPercent(p: number): string {
  return Number.isInteger(p) ? `${p}%` : `${Math.round(p * 10) / 10}%`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round((n / 1_000_000) * 10) / 10}M`;
}

/** 上下文水位 → 颜色：宽裕/刚回收都不上色（中性），过半橙，逼近阈值红。
 *  主色（蓝）只留给「握着回合的人」——别让水位跟它抢注意力。 */
function ctxColor(pct: number | null): string {
  if (pct === null) return INK;
  if (pct >= 85) return DANGER;
  if (pct >= 60) return WARN;
  return INK;
}

/** 10 格水位条：已用部分上色，未用部分中性——只有「需要注意」才显眼。 */
function ctxBar(pct: number | null, color: string): string {
  if (pct === null) return `<font color='${INK}'>░░░░░░░░░░</font>`;
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const used = `<font color='${color}'>${"█".repeat(filled)}</font>`;
  const free = `<font color='${INK}'>${"░".repeat(10 - filled)}</font>`;
  return `${used}${free}`;
}

function ctxStory(pct: number | null, peak: number | undefined): string {
  if (pct === null) return "usage unknown";
  if (peak !== undefined && peak > pct + 15) return `recovered · peak ${formatPercent(peak)}`;
  if (pct >= 85) return "near limit";
  if (pct >= 60) return "half used";
  return "room left";
}

export interface RenderOptions {
  /** 每条 lane 取最近 N 条（held 全留，与 TUI `visibleQueueMessages` 同规则；对话再封 CONVERSATION_CAP）。 */
  readonly queueTail: number;
  readonly showBoard: boolean;
}

/** 现场标题（heading 字号 = 卡片里最大的一行）：谁握着接力棒、在干什么。 */
function sceneHeadline(state: StatusState, snap: StatusSnapshots): string {
  if (snap.outcome !== undefined) {
    return snap.outcome.status === "completed"
      ? `<font color='${OK}'>task completed (${snap.outcome.reason})</font>`
      : `<font color='${INK}'>stopped (${snap.outcome.reason})</font>`;
  }
  if (state.compacting) return `<font color='${ACCENT}'>PRUNER · compacting</font>`;
  if (state.busy && state.currentRole !== undefined) {
    let doing = "working";
    if (state.activity === "thinking") doing = "thinking";
    else if (state.activity === "saying") doing = "saying";
    return `<font color='${ACCENT}'>${ACTOR_TOKEN[state.currentRole]} · ${doing}</font>`;
  }
  if (state.solverHeld) return `<font color='${WARN}'>SOLVER · held · waiting for STRATEGIST review</font>`;
  if (state.lastYield !== undefined) return `<font color='${WARN}'>SOLVER · yielded (${state.lastYield})</font>`;
  return `<font color='${INK}'>idle · nobody holds the turn</font>`;
}

function metaLine(state: StatusState, nowMs: number): string {
  const bits: string[] = [];
  if (state.turn > 0) bits.push(`turn ${state.turn}`);
  const model = modelOf(state);
  if (model !== undefined) bits.push(`\`${model}\``);
  bits.push(formatElapsed(nowMs - state.attachedAtMs));
  return bits.join(" · ");
}

function modelOf(state: StatusState): string | undefined {
  const live: ActiveRole | undefined = state.compacting ? "pruner" : state.currentRole;
  const order: readonly (ActiveRole | undefined)[] = [live, "strategist", "solver", "pruner"];
  for (const role of order) {
    if (role === undefined) continue;
    const name = state.models[role];
    if (name !== undefined) return name;
  }
  return undefined;
}

function alertLines(state: StatusState): string[] {
  const lines: string[] = [];
  if (state.retry !== undefined) {
    lines.push(
      `<font color='${WARN}'>retry ${state.retry.attempt}/${state.retry.maxAttempts}</font> · ${state.retry.delayMs}ms`,
    );
  }
  if (state.stall !== undefined) {
    lines.push(
      `<font color='${DANGER}'>stall ${state.stall.toolName} ×${state.stall.repeats}</font>`,
    );
  }
  const { calls, errors, active, last } = state.tools;
  if (calls > 0 || active !== undefined) {
    const bits = [`${calls} calls`];
    if (errors > 0) bits.push(`<font color='${DANGER}'>${errors} err</font>`);
    if (active !== undefined) bits.push(`running ${active}`);
    else if (last !== undefined) bits.push(`last ${last}`);
    lines.push(bits.join(" · "));
  }
  return lines;
}

function contextLines(state: StatusState): string[] {
  const present = CTX_ROLES.filter((role) => state.ctx[role] !== undefined);
  if (present.length === 0) return [];
  const lines = [sectionLabel("context")];
  for (const role of present) {
    const usage = state.ctx[role];
    if (usage === undefined) continue;
    const color = ctxColor(usage.pct);
    lines.push(
      `${ACTOR_TOKEN[role]}　${ctxBar(usage.pct, color)}　${usage.label}　<font color='${INK}'>${ctxStory(usage.pct, state.ctxPeak[role])}</font>`,
    );
  }
  return lines;
}

/** 段标签：中性小字（不再加粗成小标题）。 */
function sectionLabel(text: string): string {
  return `<font color='${INK}'>${text}</font>`;
}

const GOAL_TITLE: Record<LooongerGoal["status"], string> = {
  active: "goal active",
  paused: "goal paused",
  blocked: "goal blocked",
  complete: "goal complete",
};

const GOAL_COLORS: Record<LooongerGoal["status"], string> = {
  active: INK,
  paused: WARN,
  blocked: DANGER,
  complete: OK,
};

function progressLines(snap: StatusSnapshots, showBoard: boolean): string[] {
  const rows: string[] = [];
  if (showBoard && snap.goal !== undefined) {
    rows.push(
      `<font color='${GOAL_COLORS[snap.goal.status] ?? INK}'>${GOAL_TITLE[snap.goal.status] ?? snap.goal.status}</font>`,
    );
    if (snap.goal.note !== undefined && snap.goal.note.length > 0) {
      rows.push(truncate(snap.goal.note, 48));
    }
  }
  if (showBoard && snap.board !== undefined) {
    const open = snap.board.todos.filter((todo) => todo.status !== "done" && todo.status !== "skipped");
    rows.push(
      `todos ${open.length}/${snap.board.todos.length} · ideas ${snap.board.ideas.length} · mem ${snap.board.memories.length}`,
    );
    const doing = snap.board.todos
      .filter((todo) => todo.status === "in_progress" && todo.title !== undefined && todo.title.length > 0)
      .slice(0, 2)
      .map((todo) => `「${truncate(todo.title ?? "", 18)}」`);
    if (doing.length > 0) rows.push(`doing ${doing.join(" · ")}`);
  }
  if (snap.outcome !== undefined) {
    rows.push(
      snap.outcome.status === "completed"
        ? `<font color='${OK}'>task completed (${snap.outcome.reason})</font>`
        : `<font color='${INK}'>stopped (${snap.outcome.reason})</font>`,
    );
  }
  // 没内容就不挂空段头
  return rows.length > 0 ? [sectionLabel("progress"), ...rows] : [];
}

/** 尾行：只留时钟（证明卡片在实时跳动）+ 人类介入次数。事件数/速率是观察者遥测，不是任务信息。 */
function footerLine(state: StatusState, nowMs: number): string {
  const human = state.humanInputs > 0 ? ` · human ×${state.humanInputs}` : "";
  return `<font color='${INK}'>${clock(nowMs)}${human}</font>`;
}

/** 卡片正文的元素 id（CardKit 流式更新按 element_id 定位单个元素；官方上限 20 字符）。
 *  分段是「局部刷新」的事实基础：每次 flush 只推内容变化的段，某段挂掉不影响其他段。 */
export const STATUS_SECTION_IDS = {
  /** 现场标题 + meta + 告警 + 队列一行（变化最频繁：状态一跳就动）。 */
  scene: "status_scene",
  /** 他们相互说了什么（原话全文，条数封 CONVERSATION_CAP）。 */
  conversation: "status_conversation",
  /** 上下文水位条。 */
  context: "status_context",
  /** goal / board / 结局。 */
  progress: "status_progress",
  /** 时钟 + 人类介入次数（每个 flush 都变——卡片活着的证据）。 */
  footer: "status_footer",
} as const;

/** 一个 markdown 元素 = 卡片里的一段（段与段独立更新，互不拖累）。 */
export interface StatusSection {
  readonly id: string;
  readonly content: string;
}

/** 空段占位：流式更新接口要求 content 长度 ≥ 1（官方文档：1~100000 字符），而元素又必须
 *  从建卡起就存在（否则更新时找不到 element_id）——一个空格两边都满足。 */
const EMPTY_SECTION = " ";

/** 段首挂一条 `<hr>`（分隔线跟着段走：段被单独替换时不会丢分隔线）。 */
function withRule(...lines: readonly string[]): string {
  return ["<hr>", ...lines].join("\n");
}

/**
 * 渲染卡片正文——**按段拆分**（局部刷新）：
 *
 *  1. `scene`：`###` 现场标题（最大字号，答「此刻谁在干什么」；主色只给这一处）
 *     + meta + 告警 + 队列一行；
 *  2. `conversation`：`<hr>` + 他们相互说了什么（原话全文，不截断）；
 *  3. `context`：`<hr>` + 上下文水位条；
 *  4. `progress`：`<hr>` + goal / board / 结局；
 *  5. `footer`：`<hr>` + 时钟 + 人类介入次数。
 *
 *  为什么不再用一个元素扛全部：飞书流式更新是**按 element_id 的全量文本替换**，
 *  单元素方案里任何一次抖动（大文本增量重算、长内容里的特殊字符带偏 markdown、
 *  流式重开后的重推）都可能让整块正文闪没；分段后故障被关在单段里
 *  （frontend 的 flush 逐段 try/catch + 失败下轮重推），且每次只推内容变化的段。
 *  不用表格：格子窄、每表最多 5 行，会把内容切成看不懂的碎片。
 */
export function renderStatusSections(
  state: StatusState,
  snap: StatusSnapshots,
  options: RenderOptions,
  nowMs: number,
): readonly StatusSection[] {
  const scene: string[] = [`### ${sceneHeadline(state, snap)}`, "", metaLine(state, nowMs)];
  scene.push(...alertLines(state));
  const queue = queueLine(state, snap);
  if (queue !== undefined) scene.push(queue);

  // 对话（他们相互说了什么）排在上下文前面——先看来回，再看水位
  const conversation = groupConversation(flowEntries(snap, options.queueTail).slice(-CONVERSATION_CAP));
  const conversationBody =
    conversation.length > 0
      ? withRule(sectionLabel("conversation"), ...conversation.map((row) => conversationRow(row)))
      : EMPTY_SECTION;

  const ctx = contextLines(state);
  const contextBody = ctx.length > 0 ? withRule(...ctx) : EMPTY_SECTION;

  const progress = progressLines(snap, options.showBoard);
  const progressBody = progress.length > 0 ? withRule(...progress) : EMPTY_SECTION;

  return [
    { id: STATUS_SECTION_IDS.scene, content: scene.join("\n") },
    { id: STATUS_SECTION_IDS.conversation, content: conversationBody },
    { id: STATUS_SECTION_IDS.context, content: contextBody },
    { id: STATUS_SECTION_IDS.progress, content: progressBody },
    { id: STATUS_SECTION_IDS.footer, content: withRule(footerLine(state, nowMs)) },
  ];
}

/** 全量正文（本地预览 / 测试用；= 各段顺序拼接、空段跳过——与分段更新看到的一致）。 */
export function renderStatusMarkdown(
  state: StatusState,
  snap: StatusSnapshots,
  options: RenderOptions,
  nowMs: number,
): string {
  return renderStatusSections(state, snap, options, nowMs)
    .map((section) => section.content)
    .filter((content) => content.trim().length > 0)
    .join("\n");
}
