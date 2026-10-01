/** 状态模型单测：TUI 语义对齐 + 黑名单（正文绝不进卡片）。 */
import { describe, expect, test } from "bun:test";
import type { LooongerEvent } from "looonger-sdk";
import {
  ingestStatus,
  renderStatusMarkdown,
  roleChips,
  seedStatus,
  type StatusSource,
} from "../src/status-model";
import { FakeHandle } from "./fakes";

function source(): StatusSource {
  const handle = new FakeHandle();
  return handle as unknown as StatusSource;
}

function ev(event: Record<string, unknown>): LooongerEvent {
  return { sessionId: "s", ...event } as unknown as LooongerEvent;
}

const RENDER = { queueTail: 3, showBoard: true };

describe("status-model ingest", () => {
  test("seed：objective 取自 task-start-requested（goal 未 seed 的新任务）", () => {
    const state = seedStatus(source(), 1000);
    expect(state.objective).toBe("测试目标：找到内网入口");
    expect(state.busy).toBe(false);
  });

  test("在场角色 = 最后一条带角色的事实；busy 跟随 run 生命周期", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "run-started", role: "strategist" }));
    expect(state.busy).toBe(true);
    expect(state.currentRole).toBe("strategist");
    state = ingestStatus(state, ev({ type: "run-settled", role: "strategist" }));
    expect(state.busy).toBe(false);

    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    state = ingestStatus(state, ev({ type: "run-failed", role: "solver" }));
    expect(state.busy).toBe(false);
    expect(state.currentRole).toBe("solver");
  });

  test("审查闸：review-requested 按住 solver；solver 开跑释放", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "review-requested", role: "strategist", signal: {} }));
    expect(state.solverHeld).toBe(true);
    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    expect(state.solverHeld).toBe(false);
  });

  test("压缩事务：pruner 上场，互斥（芯片只有一个 live）", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    state = ingestStatus(state, ev({ type: "compaction-started", role: "pruner", reason: "threshold" }));
    expect(state.compacting).toBe(true);
    const live = roleChips(state).filter((c) => c.live).map((c) => c.role);
    expect(live).toEqual(["pruner"]);
    state = ingestStatus(state, ev({ type: "compaction-succeeded", role: "pruner", reason: "threshold" }));
    expect(state.compacting).toBe(false);
    expect(state.busy).toBe(false);
  });

  test("停滞：payload 进状态（工具名+次数）；solver 重跑清除", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "stall-detected", role: "solver", payload: { toolName: "bash", repeats: 12 } }),
    );
    expect(state.stall).toEqual({ toolName: "bash", repeats: 12 });
    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    expect(state.stall).toBeUndefined();
  });

  test("活动分类只取 kind：thinking/saying，正文不读", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "message-delta", role: "solver", messageRole: "assistant", delta: { type: "thinking_delta", delta: "flag{secret}" } }),
    );
    expect(state.activity).toBe("thinking");
    state = ingestStatus(
      state,
      ev({ type: "message-delta", role: "solver", messageRole: "assistant", delta: { type: "text_delta", delta: "继续扫" } }),
    );
    expect(state.activity).toBe("saying");
  });

  test("黑名单事件：正文绝不进状态（role/busy 仍按 TUI 口径跟事实走）", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "message-settled", role: "solver", messageRole: "assistant", content: [{ type: "text", text: "内部答案" }] }),
    );
    state = ingestStatus(
      state,
      ev({ type: "tool-settled", role: "solver", toolCallId: "t1", toolName: "bash", result: "敏感输出" }),
    );
    state = ingestStatus(
      state,
      ev({ type: "instruction-sent", role: "strategist", kind: "steer", message: "去读 /etc/passwd" }),
    );
    // 状态序列化里没有任何正文片段
    const dumped = JSON.stringify(state);
    expect(dumped).not.toContain("内部答案");
    expect(dumped).not.toContain("敏感输出");
    expect(dumped).not.toContain("/etc/passwd");
    // 事件照数（黑名单只挡内容，不挡簿记）
    expect(state.eventCount).toBe(3);
  });

  test("人类输入计数；上下文占用按角色缓存", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "human-input-received", role: null, text: "x", id: "i1" }));
    state = ingestStatus(state, ev({ type: "human-input-received", role: null, text: "y", id: "i2" }));
    expect(state.humanInputs).toBe(2);
    state = ingestStatus(
      state,
      ev({ type: "context-usage", role: "solver", usage: { tokens: 45000, contextWindow: 200000, percent: 22.5 } }),
    );
    expect(state.ctx.solver).toBe("45k/200k (22.5%)");
  });
});

describe("status-model render", () => {
  test("卡片含三角色芯片 + 队列相位 + 结论行，且不含任何角色正文", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    state = ingestStatus(
      state,
      ev({ type: "message-delta", role: "solver", messageRole: "assistant", delta: { type: "text_delta", delta: "模型私聊内容" } }),
    );
    const text = renderStatusMarkdown(
      state,
      {
        queues: {
          strategist: {
            pending: [{ id: "q1", kind: "review", content: "审查 solver 进展" }],
            history: [{ id: "q1", kind: "review", content: "审查 solver 进展" }],
            phases: { q1: "held" },
          },
          solver: {
            pending: [],
            history: [
              { id: "q2", kind: "instruction", content: "跑 scan.py" },
              { id: "q3", kind: "human-input", content: "看看 80 端口" },
            ],
            phases: { q2: "seen", q3: "inbox" },
          },
        },
        goal: { objective: "测试目标：找到内网入口", status: "active" },
        board: {
          todos: [{ status: "done" }, { status: "pending" }, { status: "in_progress" }],
          ideas: [{}, {}],
          memories: [{}],
        },
        outcome: undefined,
      } as never,
      RENDER,
      60_000,
    );
    expect(text).toContain("🟢SOL");
    expect(text).toContain("QUEUE");
    expect(text).toContain("STR ⏸ 1");
    expect(text).toContain("✓ 指令  跑 scan.py");
    expect(text).toContain("▸ 输入  看看 80 端口");
    expect(text).toContain("GOAL");
    expect(text).toContain("● active");
    expect(text).toContain("BOARD** TODO 2/3 · IDEA 2 · MEM 1");
    expect(text).toContain("事件 2"); // 只数 attach 后 ingest 的两条（seed 不吃计数）
    // 正文泄漏检查：模型流内容与工具输出都不在卡片里
    expect(text).not.toContain("模型私聊内容");
    expect(text).not.toContain("敏感输出");
    expect(text).not.toContain("/etc/passwd");
  });

  test("终局行：completed / stopped 两种结局", () => {
    const state = seedStatus(source(), 0);
    const completed = renderStatusMarkdown(
      state,
      { queues: undefined, goal: undefined, board: undefined, outcome: { status: "completed", reason: "task_completed" } },
      RENDER,
      0,
    );
    expect(completed).toContain("✅ 任务完成（task_completed）");
    const stopped = renderStatusMarkdown(
      state,
      { queues: undefined, goal: undefined, board: undefined, outcome: { status: "stopped", reason: "user_stop" } },
      RENDER,
      0,
    );
    expect(stopped).toContain("⏹ 已停止（user_stop）");
  });
});
