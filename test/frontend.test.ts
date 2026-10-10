/** 观察者生命周期单测：节流 / 白名单 / 两段式停止 / 降级 / dispose 收尾。 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createFeishuFrontend } from "../src/frontend";
import type { CardOp } from "../src/feishu-client";
import { createSilentLogger } from "../src/logger";
import { FakeCardClient, FakeEventSource, FakeHandle, ManualTimers } from "./fakes";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = {
  appId: "cli_test",
  appSecret: "secret",
  chatId: "oc_test",
  receiveIdType: "chat_id" as "chat_id" | "open_id",
  allowedSenders: ["ou_owner"],
  allowedChats: [] as readonly string[],
  baseUrl: "https://open.feishu.cn",
  flushMs: 2000,
  queueTail: 3,
  showBoard: true,
  stopConfirmWindowMs: 60_000,
};

/** 装配 + 等异步初始化（建卡/发卡/长连接都是快 Promise，两个微任务轮次足够）。 */
async function setup(): Promise<{
  handle: FakeHandle;
  cards: FakeCardClient;
  source: FakeEventSource;
  timers: ManualTimers;
  now: () => number;
}> {
  const cards = new FakeCardClient();
  const source = new FakeEventSource();
  const timers = new ManualTimers();
  let clock = 1_000_000;
  const handle = new FakeHandle();
  const observer = createFeishuFrontend({
    config: CONFIG,
    logger: createSilentLogger(),
    cardClient: cards,
    eventSource: source,
    timers,
    now: () => clock,
  });
  observer.attach(handle as never);
  await settle();
  return { handle, cards, source, timers, now: () => clock };
}

/** 私聊模式装配（receiveIdType=open_id，目标 = 授权者本人）。 */
async function setupDM(): Promise<{ cards: FakeCardClient }> {
  const cards = new FakeCardClient();
  const source = new FakeEventSource();
  const timers = new ManualTimers();
  const handle = new FakeHandle();
  createFeishuFrontend({
    config: { ...CONFIG, chatId: "ou_owner", receiveIdType: "open_id" },
    logger: createSilentLogger(),
    cardClient: cards,
    eventSource: source,
    timers,
  }).attach(handle as never);
  await settle();
  return { cards };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 所有 updateElementText 用过的 sequence（按顺序）——「不跳号」断言的事实基础。 */
function cardSequences(cards: FakeCardClient): number[] {
  return cards.calls
    .filter((c) => c.op === "updateElementText")
    .map((c) => (c.args[3] as CardOp).sequence);
}

function msg(overrides: Partial<{ messageId: string; chatId: string; senderOpenId: string; text: string }> = {}) {
  return {
    messageId: "m1",
    chatId: "oc_test",
    senderOpenId: "ou_owner",
    text: "",
    ...overrides,
  };
}

describe("飞书前端面生命周期", () => {
  test("attach：订阅先建 + 建卡发卡 + 长连接启动；首屏即推一次", async () => {
    const { cards, source } = await setup();
    expect(source.started).toBe(true);
    expect(cards.countOp("createCard")).toBe(1);
    expect(cards.countOp("sendCardToChat")).toBe(1);
    // 群模式（默认）：receive_id_type=chat_id
    expect(cards.calls[1]?.args[2]).toBe("chat_id");
    // 私聊模式：open_id 直发（不需要任何群）
    const dm = await setupDM();
    expect(dm.cards.calls[1]?.args[2]).toBe("open_id");
    expect(dm.cards.calls[1]?.args[0]).toBe("ou_owner");
    // 首屏内容在 createCard 的卡片 JSON 里（流式更新接口还没被调用）
    const cardJson = JSON.parse(cards.calls[0]?.args[0] as string) as {
      header: { title: { content: string } };
      body: { elements: Array<{ content: string }> };
    };
    // 任务本身在卡片头部标题里（正文不再重复引用它）
    expect(cardJson.header.title.content).toContain("测试目标");
    // 首屏正文 = 接力图 + 现场标题（结构在，不需要正文重复任务）
    expect(cardJson.body.elements[0]?.content).toContain("### ");
  });

  test("节流：事件只在 tick 那轮推；内容没变的段一段都不推", async () => {
    const { handle, cards, timers } = await setup();
    const before = cards.countOp("updateElementText");
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    expect(cards.countOp("updateElementText")).toBe(before); // 未 tick 不推
    timers.tick();
    expect(cards.countOp("updateElementText")).toBe(before + 1); // scene 段变了 → 只推它
    timers.tick(); // 内容没变 → 一段都不推
    expect(cards.countOp("updateElementText")).toBe(before + 1);
  });

  test("局部刷新：只推内容变化的段（人类输入只动 footer 段）", async () => {
    const { handle, source, cards, timers } = await setup();
    await source.emit(msg({ text: "看看 80 端口" }));
    const before = cards.countOp("updateElementText");
    timers.tick();
    expect(cards.countOp("updateElementText")).toBe(before + 1);
    const last = [...cards.calls].reverse().find((c) => c.op === "updateElementText");
    expect(last?.args[1]).toBe("status_footer"); // 只有时钟/人类计数那段变了
    expect(last?.args[2]).toContain("human ×1");
    expect(handle.humanInputs).toEqual(["看看 80 端口"]);
  });

  test("单段失败被关在段里：其他段照常更新，失败段下轮自动重推", async () => {
    const cards = new FakeCardClient();
    cards.failElement = "status_context"; // 该段的更新持续失败（如卡片体积超限 200860）
    const source = new FakeEventSource();
    const timers = new ManualTimers();
    const handle = new FakeHandle();
    createFeishuFrontend({
      config: CONFIG,
      logger: createSilentLogger(),
      cardClient: cards,
      eventSource: source,
      timers,
    }).attach(handle as never);
    await settle();
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    handle.pushEvent({
      type: "context-usage",
      sessionId: "s",
      role: "solver",
      usage: { tokens: 96_000, contextWindow: 200_000, percent: 48 },
    } as never);
    timers.tick();
    await settle();
    const pushed = cards.calls.filter((c) => c.op === "updateElementText").map((c) => c.args[1]);
    expect(pushed).toContain("status_scene"); // 没问题的段照常上屏
    expect(pushed).toContain("status_context"); // 问题段也尝试了（只是失败）
    // 下一轮：scene 没变不推；context 在重试队列里 → 只有它重推
    const beforeRetry = cards.countOp("updateElementText");
    timers.tick();
    await settle();
    const retried = cards.calls
      .slice(cards.calls.findIndex((c) => c.op === "updateElementText") + beforeRetry)
      .filter((c) => c.op === "updateElementText")
      .map((c) => c.args[1]);
    expect(retried).toEqual(["status_context"]);
  });

  test("sequence 协议：瞬时失败不跳号——重推沿用同一个 sequence", async () => {
    const { handle, cards, timers } = await setup();
    cards.failNextUpdateWithNetworkError = true;
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    timers.tick(); // PUT(1) 网络错——号不前进（平台也没记）
    await settle();
    timers.tick(); // 下一轮：同一个号重推
    await settle();
    expect(cardSequences(cards)).toEqual([1, 1]); // 原地重试，绝不跳号
    expect(cards.lastCardTextFor("status_scene")).toContain("SOLVER · working");
    // 之后再变脏，接着用 2（连续）
    handle.pushEvent({ type: "turn-started", sessionId: "s", role: "solver", turnIndex: 9 } as never);
    timers.tick();
    await settle();
    expect(cardSequences(cards)).toEqual([1, 1, 2]);
  });

  test("sequence 协议：300317 自愈——平台账本领先时自动让号追赶，不永久卡死", async () => {
    const { handle, cards, timers } = await setup();
    cards.advancePlatformSequenceTo(5); // 上次失败但平台已静默落账到 5（响应丢失）
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    timers.tick();
    await settle();
    // 1→300317 让号→2→…→6 对齐成功（一步步追，全程不跳号）
    expect(cardSequences(cards)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cards.lastCardTextFor("status_scene")).toContain("SOLVER · working");
    // 对齐后恢复连续
    handle.pushEvent({ type: "turn-started", sessionId: "s", role: "solver", turnIndex: 4 } as never);
    timers.tick();
    await settle();
    expect(cardSequences(cards)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("流式被关（300309）→ 自动重开 + 同文重推，卡片不卡死", async () => {
    const { handle, cards, timers } = await setup();
    cards.failNextUpdateWithStreamingClosed = true;
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "strategist" } as never);
    timers.tick();
    await settle();
    expect(cards.countOp("setStreamingMode")).toBe(1);
    // 重推成功：一次失败 + 重开后的一次成功
    const updates = cards.calls.filter((c) => c.op === "updateElementText");
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  test("白名单：允许的发送者文本 → 人类输入入队 + 回复", async () => {
    const { handle, source, cards } = await setup();
    await source.emit(msg({ text: "看看 80 端口" }));
    expect(handle.humanInputs).toEqual(["看看 80 端口"]);
    expect(cards.calls.some((c) => c.op === "replyText")).toBe(true);
  });

  test("白名单外发送者 → 拒绝（fail-closed，不入队）", async () => {
    const { handle, source, cards } = await setup();
    await source.emit(msg({ senderOpenId: "ou_stranger", text: "rm -rf /" }));
    expect(handle.humanInputs).toEqual([]);
    expect(cards.lastReplyText()).toContain("白名单");
  });

  test("/stop 两段式：请求 → 窗口内确认才停；无确认不停", async () => {
    const { handle, source } = await setup();
    await source.emit(msg({ text: "/stop" }));
    expect(handle.stopRequests.length).toBe(0); // 只请求，未停
    await source.emit(msg({ text: "/stop confirm" }));
    expect(handle.stopRequests.length).toBe(1);
  });

  test("/stop 过期（窗口外确认）→ 不停", async () => {
    const cards = new FakeCardClient();
    const source = new FakeEventSource();
    const timers = new ManualTimers();
    let clock = 1_000_000;
    const handle = new FakeHandle();
    createFeishuFrontend({
      config: { ...CONFIG, stopConfirmWindowMs: 1000 },
      logger: createSilentLogger(),
      cardClient: cards,
      eventSource: source,
      timers,
      now: () => clock,
    }).attach(handle as never);
    await settle();
    await source.emit(msg({ text: "/stop" }));
    clock += 5000; // 超过确认窗
    await source.emit(msg({ text: "/stop confirm" }));
    expect(handle.stopRequests.length).toBe(0);
  });

  test("/cancel 取消待确认的停止", async () => {
    const { handle, source } = await setup();
    await source.emit(msg({ text: "/stop" }));
    await source.emit(msg({ text: "/cancel" }));
    await source.emit(msg({ text: "/stop confirm" }));
    expect(handle.stopRequests.length).toBe(0);
  });

  test("/status → 强制立即刷新（全段重推，不等 tick）", async () => {
    const { source, cards, timers } = await setup();
    await source.emit(msg({ text: "/status" }));
    // force = 每一段都推（与「只推变化的段」互补：用户要的是一次彻底刷新）
    const pushed = cards.calls.filter((c) => c.op === "updateElementText").map((c) => c.args[1]);
    expect(pushed).toEqual([
      "status_scene",
      "status_conversation",
      "status_context",
      "status_progress",
      "status_footer",
    ]);
    timers.tick(); // 刚刷过、内容没变 → 无新增
    expect(cards.countOp("updateElementText")).toBe(pushed.length);
  });

  test("dispose：清定时器 + 终局刷新 + 关流式 + 关长连接 + 退订", async () => {
    const { handle, cards, source, timers } = await setup();
    handle.outcomeValue = { status: "completed", reason: "task_completed" };
    for (const cleanup of handle.adopted) cleanup.dispose();
    await settle();
    expect(timers.activeCount).toBe(0);
    expect(source.closed).toBe(true);
    expect(cards.lastCardTextFor("status_scene")).toContain("task completed");
    const lastStreaming = [...cards.calls].reverse().find((c) => c.op === "setStreamingMode");
    expect(lastStreaming?.args[1]).toBe(false); // streaming off
    // 退订后事件不再触发更新
    const before = cards.countOp("updateElementText");
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    timers.tick();
    expect(cards.countOp("updateElementText")).toBe(before);
  });

  test("降级：建卡失败也照常接指令（卡片没有，命令仍在）", async () => {
    const cards = new FakeCardClient();
    cards.createCard = async () => {
      throw new Error("network down");
    };
    const source = new FakeEventSource();
    const timers = new ManualTimers();
    const handle = new FakeHandle();
    createFeishuFrontend({
      config: CONFIG,
      logger: createSilentLogger(),
      cardClient: cards,
      eventSource: source,
      timers,
    }).attach(handle as never);
    await settle();
    expect(source.started).toBe(true);
    await source.emit(msg({ text: "人工指令" }));
    expect(handle.humanInputs).toEqual(["人工指令"]);
  });

  test("attach 是同步的：订阅在任何 await 之前（run#1 事件不丢）", async () => {
    const cards = new FakeCardClient();
    const source = new FakeEventSource();
    const timers = new ManualTimers();
    const handle = new FakeHandle();
    createFeishuFrontend({
      config: CONFIG,
      logger: createSilentLogger(),
      cardClient: cards,
      eventSource: source,
      timers,
    }).attach(handle as never);
    // 不 await：attach 返回后事件已在流里。attach 前窗口里的 task-start-requested 由
    // seed 消化（快照口径），事件计数从 subscribe 起算——本条 run-started 是第 1 条。
    handle.pushEvent({ type: "run-started", sessionId: "s", role: "solver" } as never);
    await settle();
    timers.tick();
    // 首屏（建卡实体）就带着同步订阅收进的事件——不用等流式更新
    const cardJson = JSON.parse(cards.calls[0]?.args[0] as string) as {
      body: { elements: Array<{ element_id: string; content: string }> };
    };
    const scene = cardJson.body.elements.find((el) => el.element_id === "status_scene");
    expect(scene?.content).toContain("### ");
    expect(scene?.content).toContain("SOLVER · working");
  });
});
