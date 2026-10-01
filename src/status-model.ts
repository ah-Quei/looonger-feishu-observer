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
  readonly ctx: Partial<Record<ActiveRole, string>>;
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
    const pct = percent === null ? "" : ` (${formatPercent(percent)})`;
    next.ctx = { ...next.ctx, [event.role]: `${used}/${window}${pct}` };
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
  const live: ActiveRole | undefined = state.compacting
    ? "pruner"
    : state.busy
      ? state.currentRole
      : undefined;
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

const ROLE_SHORT: Record<ActiveRole, string> = {
  strategist: "STR",
  solver: "SOL",
  pruner: "PRN",
};

const CHIP_MARK = { live: "🟢", held: "🟡", idle: "⚪" } as const;

const QUEUE_KIND_LABELS: Record<QueueMessage["kind"], string> = {
  objective: "目标",
  review: "审查",
  "human-input": "输入",
  instruction: "指令",
};

/** 相位标记（与 TUI `sidebar.ts` 的 held/inbox/seen/cleared 同义，载体换成 emoji）。 */
const PHASE_MARKS: Record<QueuePhase, string> = {
  held: "⏸",
  inbox: "▸",
  seen: "✓",
  cleared: "✗",
};

export interface RenderOptions {
  /** 每队列展示最近 N 条（held 全留，与 TUI `visibleQueueMessages` 同规则）。 */
  readonly queueTail: number;
  readonly showBoard: boolean;
}

function phaseOf(view: QueueView, message: QueueMessage): QueuePhase {
  const stamped = view.phases?.[message.id];
  if (stamped !== undefined) return stamped;
  return view.pending.some((item) => item.id === message.id) ? "held" : "inbox";
}

/** held 全留 + 其余最近 N 条（TUI 右栏同口径）。 */
function visibleQueueMessages(
  view: QueueView,
  tail: number,
): readonly QueueMessage[] {
  const held = view.history.filter((m) => phaseOf(view, m) === "held");
  const rest = view.history.filter((m) => {
    const phase = phaseOf(view, m);
    return phase === "inbox" || phase === "seen" || phase === "cleared";
  });
  const keep = new Set([...held, ...rest.slice(-tail)].map((m) => m.id));
  return view.history.filter((m) => keep.has(m.id));
}

function truncate(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
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
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
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

const GOAL_BADGES = {
  active: "●",
  paused: "◐",
  blocked: "■",
  complete: "✓",
} as const;

/** 渲染卡片正文（全量文本——飞书流式更新接口收全量 content，平台自己算增量）。 */
export function renderStatusMarkdown(
  state: StatusState,
  snap: StatusSnapshots,
  options: RenderOptions,
  nowMs: number,
): string {
  const lines: string[] = [];

  // 标题行：objective（截断）+ taskId
  const objective = truncate(state.objective, 40);
  lines.push(objective.length > 0 ? `**${objective}**` : `**${state.taskId}**`);
  lines.push(`\`${state.taskId}\``);

  // 芯片行
  const chips = roleChips(state)
    .map((chip) => {
      const mark = chip.live ? CHIP_MARK.live : chip.held ? CHIP_MARK.held : CHIP_MARK.idle;
      const detail = chip.detail === undefined ? "" : ` ${chip.detail}`;
      return `${mark}${ROLE_SHORT[chip.role]}${detail}`;
    })
    .join("  ·  ");
  lines.push(chips);

  // 工作行 / 压缩行
  if (state.compacting) {
    lines.push(`🗜️ 压缩中（${state.compactDetail ?? "threshold"}）`);
  } else if (state.busy) {
    const label =
      state.activity === "thinking"
        ? "Thinking"
        : state.activity === "saying"
          ? "Saying"
          : "Working";
    lines.push(`⚙️ ${label} ${formatElapsed(nowMs - state.attachedAtMs)}`);
  } else {
    lines.push(`✅ 空闲 ${formatElapsed(nowMs - state.attachedAtMs)}`);
  }

  // 停滞标记（只有工具名与次数，无输出）
  if (state.stall !== undefined) {
    lines.push(`⚠️ 停滞 ${state.stall.toolName} ×${state.stall.repeats}`);
  }

  // QUEUE 区（与 TUI 同数据源：queueSnapshot）
  lines.push("");
  lines.push("**QUEUE**");
  const queueRows: Array<{ short: string; view: QueueView | undefined }> = [
    { short: "STR", view: snap.queues?.strategist },
    { short: "SOL", view: snap.queues?.solver },
  ];
  for (const row of queueRows) {
    const pending = row.view?.pending.length ?? 0;
    const status = pending > 0 ? `⏸ ${pending}` : "idle";
    lines.push(`${row.short} ${status}`);
    if (row.view === undefined) continue;
    for (const message of visibleQueueMessages(row.view, options.queueTail)) {
      const label = QUEUE_KIND_LABELS[message.kind] ?? message.kind;
      const mark = PHASE_MARKS[phaseOf(row.view, message)] ?? "▸";
      const body = truncate(message.content, 36);
      lines.push(body.length > 0 ? `  ${mark} ${label}  ${body}` : `  ${mark} ${label}`);
    }
  }

  // GOAL / BOARD（纯计数与徽标，无正文泄漏）
  if (options.showBoard) {
    if (snap.goal !== undefined) {
      const badge = GOAL_BADGES[snap.goal.status] ?? "·";
      lines.push("");
      lines.push(`**GOAL** ${badge} ${snap.goal.status}`);
    }
    if (snap.board !== undefined) {
      const open = snap.board.todos.filter((t) => t.status !== "done" && t.status !== "skipped");
      lines.push(
        `**BOARD** TODO ${open.length}/${snap.board.todos.length} · IDEA ${snap.board.ideas.length} · MEM ${snap.board.memories.length}`,
      );
    }
  }

  // 结局
  if (snap.outcome !== undefined) {
    lines.push("");
    lines.push(
      snap.outcome.status === "completed"
        ? `✅ 任务完成（${snap.outcome.reason}）`
        : `⏹ 已停止（${snap.outcome.reason}）`,
    );
  }

  // 尾行：时钟 / 事件数 / 人类输入数
  lines.push("");
  const human = state.humanInputs > 0 ? ` · 人类输入 ${state.humanInputs}` : "";
  lines.push(`${clock(nowMs)} · 事件 ${state.eventCount}${human}`);
  return lines.join("\n");
}
