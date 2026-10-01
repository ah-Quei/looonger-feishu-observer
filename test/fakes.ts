/** 测试替身：内存飞书传输 + 手动定时器 + 假 handle。
 *  与 looonger 的「双替身对齐真机语义」同一纪律：替身只记录与断言，不加语义。 */

import type { LooongerEvent } from "looonger-sdk";
import type { BoardSnapshot, LooongerGoal, QueueMessage, QueueSnapshot, QueueView, TaskOutcome } from "looonger-sdk";
import { FeishuApiError, type FeishuCardClient, type FeishuEventSource, type FeishuIncoming } from "../src/feishu-client";
import type { FeishuHandleView } from "../src/frontend";

// ============ FakeCardClient ============

export interface FakeCardCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

export class FakeCardClient implements FeishuCardClient {
  readonly calls: FakeCardCall[] = [];
  cardIdCounter = 0;
  /** 下一次 updateElementText 抛一次「流式已关」（验证重开+重试恢复）。 */
  failNextUpdateWithStreamingClosed = false;

  async createCard(cardJson: string): Promise<string> {
    this.calls.push({ op: "createCard", args: [cardJson] });
    this.cardIdCounter += 1;
    return `card-${this.cardIdCounter}`;
  }

  async sendCardToChat(
    target: string,
    cardId: string,
    receiveIdType: "chat_id" | "open_id" = "chat_id",
  ): Promise<string> {
    this.calls.push({ op: "sendCardToChat", args: [target, cardId, receiveIdType] });
    return `msg-${cardId}`;
  }

  async updateElementText(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    this.calls.push({ op: "updateElementText", args: [cardId, elementId, content, sequence] });
    if (this.failNextUpdateWithStreamingClosed) {
      this.failNextUpdateWithStreamingClosed = false;
      throw new FeishuApiError(300309, "Card streaming closed");
    }
  }

  async setStreamingMode(cardId: string, enabled: boolean, sequence: number): Promise<void> {
    this.calls.push({ op: "setStreamingMode", args: [cardId, enabled, sequence] });
  }

  async replyText(messageId: string, text: string): Promise<void> {
    this.calls.push({ op: "replyText", args: [messageId, text] });
  }

  /** 最后一次 updateElementText 的正文（断言卡片内容用）。 */
  lastCardText(): string | undefined {
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      const call = this.calls[i];
      if (call?.op === "updateElementText") return call.args[2] as string;
    }
    return undefined;
  }

  /** 最后一次 replyText 的正文。 */
  lastReplyText(): string | undefined {
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      const call = this.calls[i];
      if (call?.op === "replyText") return call.args[1] as string;
    }
    return undefined;
  }

  countOp(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

// ============ FakeEventSource ============

export class FakeEventSource implements FeishuEventSource {
  started = false;
  closed = false;
  private handler: ((msg: FeishuIncoming) => void | Promise<void>) | undefined;

  async start(onIncoming: (msg: FeishuIncoming) => void | Promise<void>): Promise<void> {
    this.started = true;
    this.handler = onIncoming;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handler = undefined;
  }

  /** 模拟一条飞书消息（handler 是 async——await 它才能等到命令副作用完成）。 */
  async emit(msg: FeishuIncoming): Promise<void> {
    await this.handler?.(msg);
  }
}

// ============ ManualTimers ============

export class ManualTimers {
  private timers = new Map<number, () => void>();
  private nextId = 1;

  setInterval(handler: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, handler);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 跑一轮所有在册定时器（每 tick 一次 = 一个 flush 周期）。 */
  tick(): void {
    for (const handler of [...this.timers.values()]) handler();
  }

  get activeCount(): number {
    return this.timers.size;
  }
}

// ============ FakeHandle（FeishuHandleView 替身） ============

const EMPTY_VIEW: QueueView = { pending: [], history: [], phases: {} };
const EMPTY_QUEUES: QueueSnapshot = { strategist: EMPTY_VIEW, solver: EMPTY_VIEW };

export function queueMessage(
  id: string,
  target: QueueMessage["target"],
  kind: QueueMessage["kind"],
  content: string,
): QueueMessage {
  return { id, target, kind, mode: "prompt", content };
}


export class FakeHandle implements FeishuHandleView {
  readonly taskId: string;
  readonly humanInputs: string[] = [];
  readonly stopRequests: number[] = [];
  readonly adopted: Array<{ dispose(): void }> = [];
  private listeners = new Set<() => void>();
  private events: LooongerEvent[] = [];
  private revisionValue = 0;
  goalValue: LooongerGoal | undefined;
  boardValue: BoardSnapshot | undefined;
  queueValue: QueueSnapshot | undefined;
  outcomeValue: TaskOutcome | undefined;

  constructor(taskId = "task-test") {
    this.taskId = taskId;
    // 初始窗口：task-start-requested（seed 的 objective 来源）
    this.pushEvent({
      type: "task-start-requested",
      sessionId: "s",
      role: null,
      task: { taskId, objective: "测试目标：找到内网入口", brief: "", taskScope: "", cwd: "/tmp" },
    } as unknown as LooongerEvent);
  }

  get revision(): number {
    return this.revisionValue;
  }

  pushEvent(event: LooongerEvent): void {
    this.events.push(event);
    this.revisionValue += 1;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    listener(); // ViewStore 语义：订阅即补发一次
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  eventsSince(revision: number): readonly LooongerEvent[] {
    return this.events.slice(revision);
  }

  fetchWindow(): readonly LooongerEvent[] {
    return this.events;
  }

  goalSnapshot(): LooongerGoal | undefined {
    return this.goalValue;
  }

  queueSnapshot(): QueueSnapshot {
    return this.queueValue ?? EMPTY_QUEUES;
  }

  boardSnapshot(): BoardSnapshot | undefined {
    return this.boardValue;
  }

  outcome(): TaskOutcome | undefined {
    return this.outcomeValue;
  }

  async sendHumanInput(text: string): Promise<void> {
    this.humanInputs.push(text);
    this.pushEvent({
      type: "human-input-received",
      sessionId: "s",
      role: null,
      text,
      id: `in-${this.humanInputs.length}`,
    } as unknown as LooongerEvent);
  }

  async requestStop(): Promise<void> {
    this.stopRequests.push(this.stopRequests.length);
  }

  adopt(cleanup: { dispose(): void }): void {
    this.adopted.push(cleanup);
  }
}
