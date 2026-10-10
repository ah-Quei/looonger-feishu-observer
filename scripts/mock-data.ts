/** Mock 事实源：一条 ~5 分 12 秒的模拟任务流水线（真实 LooongerEvent 序列）。
 *
 *  只此一处 mock 数据——`mock-preview.ts`（静态三态）与 `mock-live.ts`（实时回放）共用，
 *  保证「贴出来看的」与「跑起来的」是同一条数据。两条消费路径都不造假事件类型：
 *  ingest 对未识别事件只是不进状态机，不会凭空造状态。
 *
 *  时间线设计（覆盖观察面全部可见态）：
 *  ① strategist 起轮 → solver 流式输出（Saying / 上下文占用 / F-8 停滞标记 / 人类输入入队）；
 *  ② solver 让路 todo_done → 审查闸（SOL 待放行）→ strategist 92% 触发压缩 → pruner 上场；
 *  ③ 压缩回收上下文 → solver 收尾 → 第二轮审查 → session-stopped（completed）。
 *
 *  快照演变（队列相位/看板/目标牌）由时间线条目的 `patches` 声明式推进——
 *  与真机语义对齐：消息被消费才 seen、审查未处理时 held 全留、goal 状态随编排迁移。
 */

import type {
  BoardSnapshot,
  LooongerEvent,
  LooongerGoal,
  QueueMessage,
  QueueSnapshot,
  TaskOutcome,
} from "looonger-sdk";
import { ingestStatus, renderStatusMarkdown, renderStatusSections, seedStatus, type StatusState, type StatusSection } from "../src/status-model";

export const MOCK_SESSION = "sess_mock_001";
export const MOCK_TASK_ID = "task-8f3a2c9e";
export const MOCK_OBJECTIVE =
  "修复 looonger CLI 在 resume 时事件窗口只回 0 条导致的状态漂移与重复 compaction";
/** 虚拟回放总时长（最后一条事件 310s + 收尾余量）。 */
export const MOCK_DURATION_MS = 312_000;

export type QueueRole = "strategist" | "solver";

// ============ 快照补丁（声明式；按时间线顺序应用到队列/看板/目标） ============

export type SnapPatch =
  | { readonly kind: "enqueue"; readonly role: QueueRole; readonly message: QueueMessage; readonly held?: boolean }
  | { readonly kind: "consume"; readonly role: QueueRole; readonly id: string }
  | { readonly kind: "goal"; readonly status: LooongerGoal["status"]; readonly note: string }
  | { readonly kind: "board"; readonly done: number }
  | { readonly kind: "outcome"; readonly outcome: TaskOutcome };

export interface TimelineEntry {
  /** 虚拟时刻（自任务开始计，毫秒）。 */
  readonly atMs: number;
  /** 事件流面板里给人看的一句话。 */
  readonly note: string;
  readonly event: LooongerEvent;
  readonly patches?: readonly SnapPatch[];
}

// ============ 队列消息（内容与真机队列同性质：事件/指令/审查/人类输入） ============

function msg(
  id: string,
  target: QueueMessage["target"],
  kind: QueueMessage["kind"],
  content: string,
): QueueMessage {
  return { id, target, kind, mode: "prompt", content };
}

const M_OBJ_STRAT = msg("m1", "strategist", "objective", "修复 resume 事件窗口只回 0 条的状态漂移");
const M_OBJ_SOLVER = msg("m3", "solver", "objective", "修复 resume 事件窗口只回 0 条的状态漂移");
const M_INSTR = msg("m2", "solver", "instruction", "先复现：repro-resume-blank.mjs 两连跑对比状态");
const M_HA_IN_1 = msg("m4", "solver", "human-input", "压缩前先把 goal note 更新为「盲区已复现」");
const M_HA_IN_2 = msg("m6", "solver", "human-input", "压缩完成后再放行 solver 收尾");
const M_REVIEW_1 = msg("m5", "strategist", "review", "[Review] solver 让路 todo_done：TODO-3 已完成，请核对收尾判据");
const M_REVIEW_2 = msg("m7", "strategist", "review", "[Review] solver 让路 todo_done：TODO-4/5 已完成，可走收尾判据");

// ============ 时间线 ============

const sec = (s: number): number => s * 1000;

export const TIMELINE: readonly TimelineEntry[] = [
  {
    atMs: 0,
    note: "会话开始（role=null）",
    event: { type: "session-started", sessionId: MOCK_SESSION, role: null },
  },
  {
    atMs: sec(0),
    note: "任务目标入账",
    event: {
      type: "task-start-requested",
      sessionId: MOCK_SESSION,
      role: null,
      task: {
        taskId: MOCK_TASK_ID,
        objective: MOCK_OBJECTIVE,
        brief: "resume 后观察者/TUI 状态与账本不一致，需定位取数窗口",
        taskScope: "packages/core/src/runtime + apps/cli",
        cwd: "/Users/dev/workspace/lab/code/looonger",
      },
    },
  },

  // ── ① strategist 起轮 → instruction 进 solver 队列 ─────────────────────
  {
    atMs: sec(8),
    note: "strategist 起一轮（读目标 / 定策略）",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "strategist" },
    patches: [{ kind: "consume", role: "strategist", id: "m1" }],
  },
  {
    atMs: sec(9),
    note: "strategist 思考（仅分类，不读正文）",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "strategist",
      messageRole: "assistant",
      delta: { type: "thinking_delta", delta: "先复现：resume 后 fetchWindow 回几条？" },
    },
  },
  {
    atMs: sec(11),
    note: "strategist 输出（Saying）",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "strategist",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "定位方向：先看 eventsSince 的 revision 起点" },
    },
  },
  {
    atMs: sec(23),
    note: "instruction 入 solver 队列",
    event: { type: "message-consumed", sessionId: MOCK_SESSION, role: "strategist", content: "instruction 已投递" },
    patches: [{ kind: "enqueue", role: "solver", message: M_INSTR }],
  },
  {
    atMs: sec(24),
    note: "strategist 本轮结束",
    event: { type: "run-settled", sessionId: MOCK_SESSION, role: "strategist" },
  },

  // ── ① solver 流式输出：Saying / 上下文 / 停滞 / 人类输入 ────────────────
  {
    atMs: sec(38),
    note: "solver 起跑（指令已投递）",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "solver" },
    patches: [{ kind: "consume", role: "solver", id: "m2" }],
  },
  {
    atMs: sec(39),
    note: "solver 模型切换为 claude-sonnet-4-5",
    event: {
      type: "model-changed",
      sessionId: MOCK_SESSION,
      role: "solver",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    },
  },
  {
    atMs: sec(40),
    note: "solver 输出：读 fetchWindow 的 revision 起点…",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "solver",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "正在读 fetchWindow 的 revision 起点…" },
    },
  },
  {
    atMs: sec(41),
    note: "turn 3 开始",
    event: { type: "turn-started", sessionId: MOCK_SESSION, role: "solver", turnIndex: 3 },
  },
  {
    atMs: sec(42),
    note: "🔧 工具 Read",
    event: {
      type: "tool-started",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_1",
      toolName: "Read",
      input: { path: "packages/core/src/task-handle.ts" },
    },
  },
  {
    atMs: sec(44),
    note: "🔧 Read 完成",
    event: {
      type: "tool-settled",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_1",
      toolName: "Read",
      result: "186 lines",
      isError: false,
    },
  },
  {
    atMs: sec(45),
    note: "solver 上下文 18.4%",
    event: {
      type: "context-usage",
      sessionId: MOCK_SESSION,
      role: "solver",
      usage: { tokens: 36_800, contextWindow: 200_000, percent: 18.4 },
    },
  },
  {
    atMs: sec(55),
    note: "🔧 工具 Grep（找 eventsSince 调用点）",
    event: {
      type: "tool-started",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_2",
      toolName: "Grep",
      input: { pattern: "eventsSince" },
    },
  },
  {
    atMs: sec(56),
    note: "🔧 Grep 完成",
    event: {
      type: "tool-settled",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_2",
      toolName: "Grep",
      result: "7 matches",
      isError: false,
    },
  },
  {
    atMs: sec(58),
    note: "🔧 工具 Edit（第一次改错位置）",
    event: {
      type: "tool-started",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_3",
      toolName: "Edit",
      input: { path: "apps/cli/src/index.ts" },
    },
  },
  {
    atMs: sec(61),
    note: "🔧 Edit 失败（old_string 不匹配）",
    event: {
      type: "tool-settled",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_3",
      toolName: "Edit",
      result: "old_string not found",
      isError: true,
    },
  },
  {
    atMs: sec(64),
    note: "🔧 工具 Edit（重试）",
    event: {
      type: "tool-started",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_4",
      toolName: "Edit",
      input: { path: "packages/core/src/task-handle.ts" },
    },
  },
  {
    atMs: sec(66),
    note: "🔧 Edit 完成",
    event: {
      type: "tool-settled",
      sessionId: MOCK_SESSION,
      role: "solver",
      toolCallId: "tc_4",
      toolName: "Edit",
      result: "ok",
      isError: false,
    },
  },
  {
    atMs: sec(70),
    note: "solver 输出：起点 = min(revision) 有坑",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "solver",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "eventsSince 起点取 min(revision)，resume 时回退 2 条" },
    },
  },
  {
    atMs: sec(95),
    note: "⚠️ F-8 停滞命中：Edit ×7",
    event: {
      type: "stall-detected",
      sessionId: MOCK_SESSION,
      role: "solver",
      payload: { kind: "a", level: "stall", toolName: "Edit", repeats: 7 },
    },
  },
  {
    atMs: sec(97),
    note: "solver 输出：定位到起点回退",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "solver",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "定位到了：resume 后起点回退了 2 条" },
    },
  },
  {
    atMs: sec(100),
    note: "🔁 流中断，重试 1/3（800ms 后）",
    event: {
      type: "run-retrying",
      sessionId: MOCK_SESSION,
      role: "solver",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 800,
      error: "stream interrupted",
    },
  },
  {
    atMs: sec(102),
    note: "🔁 第 2 次尝试开始（重试行随之清除）",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "solver" },
  },
  {
    atMs: sec(130),
    note: "人类输入入队（steer）",
    event: {
      type: "human-input-received",
      sessionId: MOCK_SESSION,
      role: null,
      text: "压缩前先把 goal note 更新为「盲区已复现」",
      id: "in_001",
    },
    patches: [{ kind: "enqueue", role: "solver", message: M_HA_IN_1 }],
  },
  {
    atMs: sec(131),
    note: "solver 消费了人类输入",
    event: { type: "message-consumed", sessionId: MOCK_SESSION, role: "solver", content: "human-input 已进会话" },
    patches: [{ kind: "consume", role: "solver", id: "m4" }],
  },
  {
    atMs: sec(140),
    note: "solver 上下文 48.2%",
    event: {
      type: "context-usage",
      sessionId: MOCK_SESSION,
      role: "solver",
      usage: { tokens: 96_400, contextWindow: 200_000, percent: 48.2 },
    },
  },
  {
    atMs: sec(150),
    note: "solver 本轮结束",
    event: { type: "run-settled", sessionId: MOCK_SESSION, role: "solver" },
  },

  // ── ② 让路 → 审查闸 → 92% 压缩 ────────────────────────────────────────
  {
    atMs: sec(151),
    note: "solver 让路：TODO-3 完成（todo_done）",
    event: { type: "solver-stopped", sessionId: MOCK_SESSION, role: "solver", reason: "todo_done" },
    patches: [{ kind: "goal", status: "blocked", note: "solver 让路 todo_done：TODO-3 完成，等审查放行 + 压缩收尾" }],
  },
  {
    atMs: sec(151),
    note: "[Review] 进 strategist 队列（held 全留）",
    event: {
      type: "review-requested",
      sessionId: MOCK_SESSION,
      role: "strategist",
      signal: {
        reason: "todo_done",
        text: "solver 让路 todo_done：TODO-3 已完成，请核对收尾判据",
        todoId: "t3",
      },
    },
    patches: [{ kind: "enqueue", role: "strategist", message: M_REVIEW_1, held: true }],
  },
  {
    atMs: sec(159),
    note: "strategist 模型切换为 claude-opus-4-5",
    event: {
      type: "model-changed",
      sessionId: MOCK_SESSION,
      role: "strategist",
      model: { provider: "anthropic", model: "claude-opus-4-5" },
    },
  },
  {
    atMs: sec(160),
    note: "strategist 起轮处理审查（SOL 待放行）",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "strategist" },
    patches: [{ kind: "consume", role: "strategist", id: "m5" }],
  },
  {
    atMs: sec(161),
    note: "strategist 输出：核对收尾判据",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "strategist",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "核对收尾判据：TODO-3 done 且回归测试在" },
    },
  },
  {
    atMs: sec(173),
    note: "strategist 上下文 92.2%（逼近阈值）",
    event: {
      type: "context-usage",
      sessionId: MOCK_SESSION,
      role: "strategist",
      usage: { tokens: 184_320, contextWindow: 200_000, percent: 92.2 },
    },
  },
  {
    atMs: sec(174),
    note: "触发压缩（threshold）",
    event: { type: "compaction-requested", sessionId: MOCK_SESSION, role: null, reason: "threshold" },
  },
  {
    atMs: sec(176),
    note: "pruner 上场（压缩事务开启）",
    event: { type: "compaction-started", sessionId: MOCK_SESSION, role: "pruner", reason: "threshold" },
  },
  {
    atMs: sec(180),
    note: "人类输入入队：压缩完成后再放行",
    event: {
      type: "human-input-received",
      sessionId: MOCK_SESSION,
      role: null,
      text: "压缩完成后再放行 solver 收尾",
      id: "in_002",
    },
    patches: [{ kind: "enqueue", role: "solver", message: M_HA_IN_2 }],
  },
  {
    atMs: sec(221),
    note: "压缩完成：184k → 26k",
    event: {
      type: "compaction-succeeded",
      sessionId: MOCK_SESSION,
      role: "pruner",
      reason: "threshold",
      summary: "压缩掉 96k 旧工具输出与早期指令",
    },
  },
  {
    atMs: sec(223),
    note: "solver 放行收尾（goal 回 active）",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "solver" },
    patches: [
      { kind: "consume", role: "solver", id: "m6" },
      { kind: "goal", status: "active", note: "压缩完成，solver 收尾 TODO-4/5 中" },
    ],
  },
  {
    atMs: sec(225),
    note: "solver 输出：TODO-4/5 收尾",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "solver",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "TODO-4/5 收尾，补 resume 盲区回归测试" },
    },
  },
  {
    atMs: sec(226),
    note: "turn 7（收尾回合）",
    event: { type: "turn-started", sessionId: MOCK_SESSION, role: "solver", turnIndex: 7 },
  },
  {
    atMs: sec(230),
    note: "solver 上下文 13.3%（压缩回收）",
    event: {
      type: "context-usage",
      sessionId: MOCK_SESSION,
      role: "solver",
      usage: { tokens: 26_600, contextWindow: 200_000, percent: 13.3 },
    },
  },
  {
    atMs: sec(270),
    note: "solver 本轮结束",
    event: { type: "run-settled", sessionId: MOCK_SESSION, role: "solver" },
  },

  // ── ③ 第二轮审查 → 判定完成 → 收尾 ────────────────────────────────────
  {
    atMs: sec(271),
    note: "solver 让路：TODO-4/5 完成（todo_done）",
    event: { type: "solver-stopped", sessionId: MOCK_SESSION, role: "solver", reason: "todo_done" },
    patches: [{ kind: "board", done: 5 }],
  },
  {
    atMs: sec(271),
    note: "[Review] 进 strategist 队列（held）",
    event: {
      type: "review-requested",
      sessionId: MOCK_SESSION,
      role: "strategist",
      signal: {
        reason: "todo_done",
        text: "solver 让路 todo_done：TODO-4/5 已完成，可走收尾判据",
        todoId: "t5",
      },
    },
    patches: [{ kind: "enqueue", role: "strategist", message: M_REVIEW_2, held: true }],
  },
  {
    atMs: sec(285),
    note: "strategist 起轮判定收尾",
    event: { type: "run-started", sessionId: MOCK_SESSION, role: "strategist" },
    patches: [{ kind: "consume", role: "strategist", id: "m7" }],
  },
  {
    atMs: sec(286),
    note: "strategist 思考：收尾判据全绿？",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "strategist",
      messageRole: "assistant",
      delta: { type: "thinking_delta", delta: "TODO 5/5、回归测试在、goal note 已更新" },
    },
  },
  {
    atMs: sec(295),
    note: "strategist 输出：走收尾判据",
    event: {
      type: "message-delta",
      sessionId: MOCK_SESSION,
      role: "strategist",
      messageRole: "assistant",
      delta: { type: "text_delta", delta: "判据全绿 → task_completed" },
    },
  },
  {
    atMs: sec(300),
    note: "收尾判据已消耗",
    event: { type: "message-consumed", sessionId: MOCK_SESSION, role: "strategist", content: "收尾判据确认" },
  },
  {
    atMs: sec(310),
    note: "session-stopped（task_completed）——落停收口",
    event: { type: "session-stopped", sessionId: MOCK_SESSION, role: null, reason: "task_completed" },
    patches: [
      { kind: "goal", status: "complete", note: "盲区已修：revision 起点改取账本最新 + 回归测试通过" },
      { kind: "outcome", outcome: { status: "completed", reason: "task_completed" } },
    ],
  },
];

// ============ 初值 / 派生 ============

const GOAL_ACTIVE: LooongerGoal = {
  objective: MOCK_OBJECTIVE,
  status: "active",
  note: "已复现：resume 后 fetchWindow 只回 0 条（起点回退 2 条）",
  createdAt: "2026-09-15T15:10:00+08:00",
  updatedAt: "2026-09-15T15:10:00+08:00",
  updatedBy: "strategist",
};

/** 看板（done = 已完成 TODO 数；渲染只数 open/total/ideas/memories，不看正文）。 */
export function mockBoard(done: number): BoardSnapshot {
  const titles = [
    "定位 fetchWindow 起点回退",
    "修 revision 起点取数",
    "补 resume 盲区回归测试",
    "对齐 TUI/观察者状态断言",
    "更新 README 盲区说明",
  ];
  const todos = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i + 1}`,
    title: titles[i] ?? `TODO-${i + 1}`,
    status: (i < done ? "done" : i === done ? "in_progress" : "pending") as BoardSnapshot["todos"][number]["status"],
    createdAt: "2026-09-15T15:11:00+08:00",
    doneAt: i < done ? "2026-09-15T15:22:00+08:00" : undefined,
  }));
  return {
    todos,
    ideas: [
      { id: "i1", content: "compaction 后策略 prompt 缓存命中率下降", status: "pending" as const, createdAt: "", updatedAt: "" },
      { id: "i2", content: "fetchWindow 可否 cursor 化", status: "testing" as const, createdAt: "", updatedAt: "" },
    ],
    memories: [
      { id: "mem1", kind: "fact" as const, content: "resume 走账本 replay，不走事件总线重放", createdAt: "" },
      { id: "mem2", kind: "warning" as const, content: "fetchWindow 起点 = min(revision) 时有 2 条盲区", createdAt: "" },
      { id: "mem3", kind: "constraint" as const, content: "观察者不读 message-* 正文", createdAt: "" },
    ],
  };
}

const SEED_SOURCE = {
  taskId: MOCK_TASK_ID,
  goalSnapshot: () => GOAL_ACTIVE,
  queueSnapshot: () => ({
    strategist: { pending: [], history: [M_OBJ_STRAT] },
    solver: { pending: [], history: [M_OBJ_SOLVER] },
  }),
  boardSnapshot: () => mockBoard(1),
  fetchWindow: () => TIMELINE.map((entry) => entry.event),
};

export interface FiredEvent {
  readonly atMs: number;
  readonly note: string;
  readonly event: LooongerEvent;
}

const RENDER_OPTS = { queueTail: 6, showBoard: true } as const;

/** 回放世界：唯一可变状态。`attachedAtMs` 是「观察者 attach 时刻」——卡片 elapsed 以它为原点。 */
export class MockWorld {
  private cursor = 0;
  private virtualMs = 0;
  private state: StatusState;
  private queues: QueueSnapshot = {
    strategist: { pending: [], history: [M_OBJ_STRAT] },
    solver: { pending: [], history: [M_OBJ_SOLVER] },
  };
  private goal: LooongerGoal = GOAL_ACTIVE;
  private board: BoardSnapshot = mockBoard(1);
  private outcome: TaskOutcome | undefined;
  readonly fired: FiredEvent[] = [];

  constructor(private readonly attachedAtMs: number) {
    this.state = seedStatus(SEED_SOURCE, attachedAtMs);
  }

  /** 推进到虚拟时刻；返回本次新应用的事件数（0 = 无新事实，世界没变）。 */
  advanceTo(virtualMs: number): number {
    let applied = 0;
    while (this.cursor < TIMELINE.length) {
      const entry = TIMELINE[this.cursor];
      if (entry === undefined || entry.atMs > virtualMs) break;
      this.state = ingestStatus(this.state, entry.event);
      this.virtualMs = entry.atMs;
      this.fired.push({ atMs: entry.atMs, note: entry.note, event: entry.event });
      if (entry.patches !== undefined) {
        for (const patch of entry.patches) this.applyPatch(patch, entry.atMs);
      }
      this.cursor += 1;
      applied += 1;
    }
    return applied;
  }

  get done(): boolean {
    return this.cursor >= TIMELINE.length;
  }

  /** 当前时刻的卡片正文（全量文本——真机由流式更新接口推送，平台算增量）。 */
  markdown(): string {
    return renderStatusMarkdown(
      this.state,
      { queues: this.queues, goal: this.goal, board: this.board, outcome: this.outcome },
      RENDER_OPTS,
      this.attachedAtMs + this.virtualMs,
    );
  }

  /** 当前时刻的分段正文（真机 flush 同口径：按段局部推送，只推内容变化的段）。 */
  sections(): readonly StatusSection[] {
    return renderStatusSections(
      this.state,
      { queues: this.queues, goal: this.goal, board: this.board, outcome: this.outcome },
      RENDER_OPTS,
      this.attachedAtMs + this.virtualMs,
    );
  }

  headerTitle(): string {
    return this.state.objective.length > 0 ? this.state.objective : `任务 ${MOCK_TASK_ID}`;
  }

  private applyPatch(patch: SnapPatch, atMs: number): void {
    switch (patch.kind) {
      case "enqueue": {
        const view = this.queues[patch.role];
        this.queues = {
          ...this.queues,
          [patch.role]: {
            pending: patch.held === true ? [...view.pending, patch.message] : view.pending,
            history: [...view.history, patch.message],
            phases: { ...(view.phases ?? {}), [patch.message.id]: patch.held === true ? "held" : "inbox" },
          },
        };
        return;
      }
      case "consume": {
        const view = this.queues[patch.role];
        this.queues = {
          ...this.queues,
          [patch.role]: {
            pending: view.pending.filter((m) => m.id !== patch.id),
            history: view.history,
            phases: { ...(view.phases ?? {}), [patch.id]: "seen" },
          },
        };
        return;
      }
      case "goal": {
        this.goal = {
          ...this.goal,
          status: patch.status,
          note: patch.note,
          updatedAt: new Date(this.attachedAtMs + atMs).toISOString(),
        };
        return;
      }
      case "board": {
        this.board = mockBoard(patch.done);
        return;
      }
      case "outcome": {
        this.outcome = patch.outcome;
        return;
      }
    }
  }
}

/** mm:ss（事件流面板用）。 */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
