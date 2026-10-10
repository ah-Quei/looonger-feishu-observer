/** 状态模型单测：TUI 语义对齐 + 黑名单（正文绝不进卡片）。 */
import { describe, expect, test } from "bun:test";
import type { LooongerEvent } from "looonger-sdk";
import {
  ingestStatus,
  renderStatusMarkdown,
  renderStatusSections,
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
    expect(state.ctx.solver?.label).toBe("45k/200k (22.5%)");
    expect(state.ctx.solver?.pct).toBe(22.5);
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
    expect(text).toContain("### <font color='blue'>SOLVER · saying</font>");
    expect(text).toContain("queues  STRATEGIST 1 <font color='orange'>(1 held)</font> · SOLVER 2"); // 闸门压成一行
    expect(text).toContain("conversation");
    expect(text).toContain("跑 scan.py");
    expect(text).toContain("看看 80 端口");
    expect(text).toContain("goal active");
    expect(text).toContain("todos 2/3");
    expect(text).toContain("ideas 2");
    expect(text).toContain("mem 1");
    // 尾行只留时钟（事件数是观察者遥测，不上卡片）
    expect(text).not.toContain("events");
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
    expect(completed).toContain("task completed (task_completed)");
    const stopped = renderStatusMarkdown(
      state,
      { queues: undefined, goal: undefined, board: undefined, outcome: { status: "stopped", reason: "user_stop" } },
      RENDER,
      0,
    );
    expect(stopped).toContain("stopped (user_stop)");
  });
});

const EMPTY_SNAP = { queues: undefined, goal: undefined, board: undefined, outcome: undefined } as const;

describe("status-model render：分段 + 对话不截断", () => {
  test("conversation 原话全文进卡片：长内容不截断（只封条数，不切内容）", () => {
    const state = seedStatus(source(), 0);
    const long = "先复现：repro-resume-blank.mjs 两连跑对比状态，再定位 eventsSince 取数窗口。".repeat(4);
    const text = renderStatusMarkdown(
      state,
      {
        queues: {
          strategist: { pending: [], history: [] },
          solver: {
            pending: [],
            history: [{ id: "q2", target: "solver", kind: "instruction", mode: "prompt", content: long }],
            phases: { q2: "seen" },
          },
        },
        goal: undefined,
        board: undefined,
        outcome: undefined,
      } as never,
      RENDER,
      1000,
    );
    expect(text).toContain(long); // 全文，一个字符都不少
    expect(text).not.toContain("…"); // 没有任何省略号
  });

  test("分段渲染：5 个 element 顺序固定；空段是占位（流式接口要求 content 长度 ≥1）", () => {
    const state = seedStatus(source(), 0);
    const sections = renderStatusSections(state, EMPTY_SNAP, RENDER, 1000);
    expect(sections.map((s) => s.id)).toEqual([
      "status_scene",
      "status_conversation",
      "status_context",
      "status_progress",
      "status_footer",
    ]);
    expect(sections[0]?.content).toContain("### ");
    // 无队列/无上下文/无 goal 时，三个中段是占位空格（元素必须存在，否则流式更新找不到 element_id）
    expect(sections[1]?.content).toBe(" ");
    expect(sections[2]?.content).toBe(" ");
    expect(sections[3]?.content).toBe(" ");
    expect(sections[4]?.content).toContain("<hr>");
    // 全量正文 = 各段拼接、空段跳过——与分段更新在卡片上看到的一致
    expect(renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 1000)).toBe(
      [sections[0]?.content, sections[4]?.content].join("\n"),
    );
  });

  test("分段渲染：有内容时段自带 <hr>，与单元素全量正文等价", () => {
    const state = seedStatus(source(), 0);
    const snap = {
      queues: {
        strategist: {
          pending: [],
          history: [{ id: "q1", target: "strategist", kind: "review", mode: "prompt", content: "审查收尾判据" }],
          phases: { q1: "held" },
        },
        solver: { pending: [], history: [], phases: {} },
      },
      goal: undefined,
      board: undefined,
      outcome: undefined,
    } as never;
    const sections = renderStatusSections(state, snap, RENDER, 1000);
    const conversation = sections.find((s) => s.id === "status_conversation");
    expect(conversation?.content.startsWith("<hr>")).toBe(true);
    expect(conversation?.content).toContain("审查收尾判据");
    // 拼回全量正文后，段落顺序与旧版单元素渲染一致（hr 不丢、不加空行）
    expect(renderStatusMarkdown(state, snap, RENDER, 1000)).toBe(
      sections
        .map((s) => s.content)
        .filter((c) => c.trim().length > 0)
        .join("\n"),
    );
  });
});

describe("status-model render：新监控面（上下文条/工具/重试/回合/模型）", () => {
  test("上下文条 + 水位配色（≥85 红 / ≥60 橙 / 其余绿）", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "context-usage", role: "solver", usage: { tokens: 96_000, contextWindow: 200_000, percent: 48 } }),
    );
    state = ingestStatus(
      state,
      ev({ type: "context-usage", role: "strategist", usage: { tokens: 184_000, contextWindow: 200_000, percent: 92 } }),
    );
    const text = renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 60_000);
    expect(text).toContain("96k/200k (48%)");
    expect(text).toContain("<font color='red'>█████████</font><font color='neutral'>░</font>"); // 92% → 9 格红 + 1 格中性
    // 48% 宽裕：整条中性（默认不上色，只有需要注意才显眼）
    expect(text).toContain("<font color='neutral'>█████</font><font color='neutral'>░░░░░</font>");
    expect(text).toContain("near limit");
    expect(text).toContain("room left");
  });

  test("上下文峰值标记：压缩回收后能看到「曾 92%」", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "context-usage", role: "solver", usage: { tokens: 184_000, contextWindow: 200_000, percent: 92 } }),
    );
    state = ingestStatus(
      state,
      ev({ type: "context-usage", role: "solver", usage: { tokens: 26_600, contextWindow: 200_000, percent: 13.3 } }),
    );
    const text = renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 60_000);
    expect(text).toContain("peak 92%");
    expect(text).toContain("recovered · peak 92%");
    expect(text).not.toContain("near limit");
  });

  test("工具记账：只读 toolName/isError，结果正文绝不进卡片", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "tool-started", role: "solver", toolCallId: "c1", toolName: "Edit", input: { secret: "x" } }),
    );
    state = ingestStatus(
      state,
      ev({ type: "tool-settled", role: "solver", toolCallId: "c1", toolName: "Edit", result: "机密输出", isError: true }),
    );
    state = ingestStatus(
      state,
      ev({ type: "tool-started", role: "solver", toolCallId: "c2", toolName: "Bash", input: {} }),
    );
    expect(state.tools).toEqual({ calls: 1, errors: 1, active: "Bash", last: "Edit" });
    const text = renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 1000);
    expect(text).toContain("1 calls");
    expect(text).toContain("1 err");
    expect(text).toContain("running Bash");
    expect(text).not.toContain("机密输出");
  });

  test("重试：attempt/max/delay 可见，error 正文不进卡片；下一轮 run 即清", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(
      state,
      ev({ type: "run-retrying", role: "solver", attempt: 1, maxAttempts: 3, delayMs: 800, error: "provider 500" }),
    );
    const during = renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 1000);
    expect(during).toContain("retry 1/3");
    expect(during).toContain("800ms");
    expect(during).not.toContain("provider 500");
    state = ingestStatus(state, ev({ type: "run-started", role: "solver" }));
    expect(state.retry).toBeUndefined();
  });

  test("回合 + 模型（换模型/降级可观测）", () => {
    let state = seedStatus(source(), 0);
    state = ingestStatus(state, ev({ type: "turn-started", role: "solver", turnIndex: 7 }));
    state = ingestStatus(
      state,
      ev({ type: "model-changed", role: "solver", model: { provider: "anthropic", model: "claude-sonnet-4-5" } }),
    );
    const text = renderStatusMarkdown(state, EMPTY_SNAP, RENDER, 1000);
    expect(text).toContain("turn 7");
    expect(text).toContain("`claude-sonnet-4-5`");
  });

  test("时间线封 FLOW_CAP，超出折成「… N earlier」", () => {
    let state = seedStatus(source(), 0);
    const history = Array.from({ length: 8 }, (_, i) => ({
      id: `q${i}`,
      target: "solver" as const,
      kind: "instruction" as const,
      mode: "prompt" as const,
      content: `指令 ${i}`,
    }));
    const text = renderStatusMarkdown(
      state,
      { queues: { strategist: { pending: [], history: [] }, solver: { pending: [], history, phases: {} } }, goal: undefined, board: undefined, outcome: undefined },
      { queueTail: 10, showBoard: false },
      1000,
    );
    const itemRows = text.split("\n").filter((l) => l.includes("指令 "));
    expect(itemRows.length).toBe(6); // CONVERSATION_CAP
    expect(text).toContain("conversation");
    expect(text).not.toContain("| --- |");
  });

  test("GOAL note + 进行中 TODO 标题（元信息，无正文泄漏）", () => {
    const state = seedStatus(source(), 0);
    const text = renderStatusMarkdown(
      state,
      {
        queues: undefined,
        goal: { objective: "测试目标：找到内网入口", status: "blocked", note: "等审查放行", createdAt: "", updatedAt: "", updatedBy: "strategist" },
        board: {
          todos: [{ id: "t1", title: "修 resume 盲区", status: "in_progress", createdAt: "", doneAt: undefined }],
          ideas: [],
          memories: [],
        },
        outcome: undefined,
      } as never,
      RENDER,
      1000,
    );
    expect(text).toContain("<font color='red'>goal blocked</font>");
    expect(text).toContain("等审查放行");
    expect(text).toContain("doing 「修 resume 盲区」");
  });
});
