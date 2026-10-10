/** 飞书前端面（TaskFrontend 实现）。
 *
 *  契约（`docs/DOMAIN-AUTHORING.md` §7）：
 *  - `attach(handle)` 在 handle 建成、**start 之前**同步调用——订阅必须同步建，事件从第一毫秒不丢；
 *  - **监听回调绝不 await**：只搬运事实 + 打脏标记；所有飞书 IO 在 flush 定时器 drain 里；
 *  - 清理走 `handle.adopt({ dispose })`（不是 attach 返回值）；
 *  - 飞书任何失败（网络/限额/配置错）只降级日志，**绝不冒泡到任务**。
 *
 *  交互口径：
 *  - 普通文本 = 人类输入（`handle.sendHumanInput` → strategist 审查队列，与 TUI 同一条路）；
 *  - `/status` 立即刷卡片；`/stop` 两段式确认后 `handle.requestStop()`；
 *  - 只推**运行状态**（角色接力/队列/目标/占用/结局），不转发三角色消息流正文。
 *  卡片更新口径：**分段局部刷新**——正文按段（scene/conversation/context/progress/footer）
 *  各一个 markdown 元素，每次 flush 只推内容变化的段；单段失败只进重试队列下轮重推，
 *  其他段照常更新——某一段的问题不会再让整块卡片消失。
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { TaskFrontend, TaskHandle } from "looonger-sdk";
import type { StatusSection, StatusSnapshots, StatusState } from "./status-model";
import { ingestStatus, renderStatusSections, seedStatus } from "./status-model";
import { parseCommand, FEISHU_HELP_TEXT } from "./commands";
import { buildStatusCard, cardJsonString } from "./card";
import { loadFeishuConfig, type FeishuConfig } from "./config";
import {
  createLarkCardClient,
  createLarkEventSource,
  isSequenceCompareFailedError,
  isStreamingClosedError,
  type CardOp,
  type FeishuCardClient,
  type FeishuEventSource,
  type FeishuIncoming,
} from "./feishu-client";
import { createScopedLogger, type FeishuLogger } from "./logger";

/** 观察者实际用到的 handle 面（TaskHandle 的结构子集——测试用替身即可装配）。 */
export interface FeishuHandleView {
  readonly taskId: string;
  readonly revision: number;
  subscribe(listener: () => void): { dispose(): void };
  eventsSince(revision: number): readonly import("looonger-sdk").LooongerEvent[];
  fetchWindow(): readonly import("looonger-sdk").LooongerEvent[];
  goalSnapshot(): import("looonger-sdk").LooongerGoal | undefined;
  queueSnapshot(): import("looonger-sdk").QueueSnapshot;
  boardSnapshot(): import("looonger-sdk").BoardSnapshot | undefined;
  outcome(): import("looonger-sdk").TaskOutcome | undefined;
  sendHumanInput(text: string): Promise<void>;
  requestStop(): Promise<void>;
  adopt(cleanup: { dispose(): void }): void;
}

/** 定时器句柄：Node 的 `Timeout` / 浏览器与测试替身的 `number` 都要能装下。 */
export type TimerHandle = ReturnType<typeof setInterval> | number;

export interface FeishuFrontendOptions {
  /** 已加载的配置（测试/宿主直传）；与 configPath 二选一。 */
  readonly config?: FeishuConfig;
  /** feishu.json 路径（manifest 装订用；attach 时懒加载，失败 = 降级无卡片）。 */
  readonly configPath?: string;
  readonly logger?: FeishuLogger;
  readonly now?: () => number;
  readonly timers?: {
    setInterval(handler: () => void, ms: number): TimerHandle;
    clearInterval(handle: TimerHandle): void;
  };
  readonly cardClient?: FeishuCardClient;
  readonly eventSource?: FeishuEventSource;
}

export function createFeishuFrontend(options: FeishuFrontendOptions = {}): TaskFrontend {
  const logger = options.logger ?? createScopedLogger();
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? {
    setInterval: (handler, ms): TimerHandle => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  return {
    attach(handle: TaskHandle): void {
      // SAFETY: TaskHandle 是 FeishuHandleView 的结构超集（观察者只用其子集方法）；
      // 编译期无法从 SDK 泛型证明这一点，运行时由 attachFeishu 只调用子集来保证。
      attachFeishu(handle as unknown as FeishuHandleView, options, logger, now, timers);
    },
  };
}

function attachFeishu(
  handle: FeishuHandleView,
  options: FeishuFrontendOptions,
  logger: FeishuLogger,
  now: () => number,
  timers: {
    setInterval(handler: () => void, ms: number): TimerHandle;
    clearInterval(handle: TimerHandle): void;
  },
): void {
  let state: StatusState;
  let cursor: number;
  let subscription: { dispose(): void } | undefined;
  try {
    state = seedStatus(handle, now());
    cursor = handle.revision;
    // 同步订阅（回调里只搬运 + 打脏标记，绝不 await——见 DOMAIN-AUTHORING §7 纪律 1）
    subscription = handle.subscribe(() => {
      try {
        for (const event of handle.eventsSince(cursor)) state = ingestStatus(state, event);
        cursor = handle.revision;
      } catch (err) {
        logger.warn("事件搬运失败（跳过本批）", { error: String(err) });
      }
    });
  } catch (err) {
    logger.error("订阅失败（观察者不生效）", { error: String(err) });
    return;
  }

  let config: FeishuConfig | undefined = options.config;
  let cardClient: FeishuCardClient | undefined = options.cardClient;
  let eventSource: FeishuEventSource | undefined = options.eventSource;
  let cardId: string | undefined;
  let timerHandle: TimerHandle | undefined;
  let sequence = 0;
  /** 单次 cardOp 里允许的让号轮数（平台账本领先我们时一步步追上；追不上就抛给下轮 flush）。 */
  const CARD_OP_MAX_ROUNDS = 8;
  let flushing = false;
  let flushAgain = false;
  let pendingStopAt: number | undefined;
  /** 每个元素最后一次推送成功的正文——局部刷新的比对基准：没变的段不推。 */
  const lastPushed = new Map<string, string>();
  /** 推送失败的元素：下轮重推（即使内容没变——失败不该让某段停在旧内容）。 */
  const failedSections = new Set<string>();

  function renderOptions(): { queueTail: number; showBoard: boolean } {
    return {
      queueTail: config?.queueTail ?? 6,
      showBoard: config?.showBoard ?? true,
    };
  }

  /** 快照现取（TUI 同口径：事件只打脏，渲染读快照——resume 盲区因此自愈）。 */
  function snapshots(): StatusSnapshots {
    const safe = <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch {
        return undefined;
      }
    };
    return {
      queues: safe(() => handle.queueSnapshot()),
      goal: safe(() => handle.goalSnapshot()),
      board: safe(() => handle.boardSnapshot()),
      outcome: handle.outcome(),
    };
  }

  /** 唯一碰飞书卡片 IO 的地方：**逐段局部刷新**——只推内容变化的段（force = 全推）。
   *  单段失败只拖累它自己（进 failedSections 下轮重推），其他段照常更新——卡片永远不会
   *  因为某一段的问题整块消失。流式被关（10 分钟无开启动作自动关）则重开后重推该段。 */
  async function flush(force: boolean): Promise<void> {
    if (cardId === undefined || cardClient === undefined) return;
    if (flushing) {
      flushAgain = true; // 上一轮还在跑：合并进来，跑完补一轮（sequence 须严格递增，不能并发交错）
      return;
    }
    flushing = true;
    try {
      do {
        flushAgain = false;
        await pushSections(force);
      } while (flushAgain);
    } finally {
      flushing = false;
    }
  }

  /** 一次卡片操作（PUT 元素内容 / PATCH 卡片配置）——sequence 协议的唯一定义点：
   *
   *  - 成功 → `sequence` 前进到本次使用的号；
   *  - 300317（平台已收过这个号：上次失败但其实落账了）→ 把号让给平台，下一个号重试；
   *  - 其他失败（网络 / 300309 流式被关 / 超时）→ **号不前进**，调用方原地重试——
   *    重试沿用同一个号，绝不跳号。
   *
   *  为什么必须这样：飞书要求同一张卡片的操作 sequence **连续递增**（官方 300317 语义）。
   *  旧实现是「先 +1 再用」：任何一次失败都会让下一次跳过一个号，平台账本从此永远比
   *  我们大——卡片永久 300317、停止刷新（用户实际踩到的坑：任务安静 10 分钟 → 流式
   *  自动关 300309 → 旧重开路径连跳两个号 → 永久冻结 + 每 2s 一条 warn）。
   *  uuid 每次尝试都带：网络层重发时平台凭它把重复请求认成同一次操作。 */
  async function cardOp<T>(call: (op: CardOp) => Promise<T>): Promise<T> {
    for (let round = 0; round < CARD_OP_MAX_ROUNDS; round += 1) {
      const op: CardOp = { sequence: sequence + 1, uuid: randomUUID() };
      try {
        const result = await call(op);
        sequence = op.sequence; // 平台确认了才前进
        return result;
      } catch (err) {
        if (isSequenceCompareFailedError(err)) {
          sequence = op.sequence; // 平台已收过该号：让给它，下一个号再来
          continue;
        }
        throw err; // 号不确认 → 调用方用同一个号原地重试（不跳号）
      }
    }
    throw new Error(
      `[feishu] 卡片操作连续 ${CARD_OP_MAX_ROUNDS} 轮没对上 sequence（平台账本领先过多？下轮 flush 继续追）`,
    );
  }

  /** 推一段：流式被关（10 分钟无开启动作自动关）→ 重开 + 同段重推。
   *  重开沿用未确认的号——平台没收过上次失败的 PUT，这个号就是下一个；若收过（罕见），
   *  cardOp 会收到 300317 并自动让号。两条路都不会跳号。 */
  async function pushSection(
    client: FeishuCardClient,
    card: string,
    section: StatusSection,
  ): Promise<void> {
    try {
      await cardOp((op) => client.updateElementText(card, section.id, section.content, op));
    } catch (err) {
      if (!isStreamingClosedError(err)) throw err;
      await cardOp((op) => client.setStreamingMode(card, true, op));
      await cardOp((op) => client.updateElementText(card, section.id, section.content, op));
    }
  }

  /** 逐段推送：内容没变且没失败过的段直接跳过（不占 sequence、不触发平台重绘）。 */
  async function pushSections(force: boolean): Promise<void> {
    const card = cardId;
    const client = cardClient;
    if (card === undefined || client === undefined) return;
    const sections = renderStatusSections(state, snapshots(), renderOptions(), now());
    for (const section of sections) {
      const unchanged = lastPushed.get(section.id) === section.content;
      if (!force && unchanged && !failedSections.has(section.id)) continue;
      try {
        await pushSection(client, card, section);
        lastPushed.set(section.id, section.content);
        failedSections.delete(section.id);
      } catch (err) {
        failedSections.add(section.id);
        logger.warn("卡片段落更新失败（下轮重推；其他段不受影响）", {
          element: section.id,
          error: String(err),
        });
      }
    }
  }

  async function reply(messageId: string, text: string): Promise<void> {
    if (cardClient === undefined) {
      logger.info("（无传输层）命令回复", { text });
      return;
    }
    try {
      await cardClient.replyText(messageId, text);
    } catch (err) {
      logger.warn("命令回复失败", { error: String(err) });
    }
  }

  function isAllowed(msg: FeishuIncoming): boolean {
    if (config === undefined || !config.allowedSenders.includes(msg.senderOpenId)) return false;
    if (config.allowedChats.length > 0 && !config.allowedChats.includes(msg.chatId)) return false;
    return true;
  }

  /** 指令路由（WS 长连接 handler——不是 ViewStore 回调，await 安全）。 */
  async function onIncoming(msg: FeishuIncoming): Promise<void> {
    if (!isAllowed(msg)) {
      await reply(msg.messageId, "⛔ 不在白名单——人类输入与命令已忽略");
      return;
    }
    const command = parseCommand(msg.text);
    switch (command.kind) {
      case "human-input":
        await handle.sendHumanInput(command.text);
        await reply(msg.messageId, "已入队 ✓（strategist 审查中）");
        return;
      case "status":
        await flush(true);
        await reply(msg.messageId, "已刷新状态卡片");
        return;
      case "stop-request":
        pendingStopAt = now();
        await reply(
          msg.messageId,
          `确认停止？${Math.round((config?.stopConfirmWindowMs ?? 60_000) / 1000)}s 内发 /stop confirm（/cancel 取消）`,
        );
        return;
      case "stop-confirm": {
        const windowMs = config?.stopConfirmWindowMs ?? 60_000;
        const pending = pendingStopAt;
        if (pending !== undefined && now() - pending <= windowMs) {
          pendingStopAt = undefined;
          await handle.requestStop();
          await reply(msg.messageId, "已请求停止 ⏹");
        } else {
          await reply(msg.messageId, "没有待确认的停止请求（或已过期）");
        }
        return;
      }
      case "stop-cancel":
        pendingStopAt = undefined;
        await reply(msg.messageId, "已取消停止请求");
        return;
      case "help":
        await reply(msg.messageId, FEISHU_HELP_TEXT);
        return;
    }
  }

  // 异步初始化：先接指令（卡片挂了也能用），再建卡推送；配置/网络失败 → 降级
  void (async () => {
    try {
      if (config === undefined) {
        if (options.configPath === undefined) {
          throw new Error("未提供 config 或 configPath");
        }
        config = await loadFeishuConfig(options.configPath);
      }
      if (cardClient === undefined) cardClient = createLarkCardClient(config, logger);
      if (eventSource === undefined) eventSource = createLarkEventSource(config, logger);
      await eventSource.start(onIncoming);
    } catch (err) {
      logger.error("飞书观察者初始化失败（降级：无卡片、无指令）", { error: String(err) });
      return;
    }
    try {
      const sections = renderStatusSections(state, snapshots(), renderOptions(), now());
      const title = state.objective.length > 0 ? state.objective : `任务 ${handle.taskId}`;
      cardId = await cardClient.createCard(cardJsonString(buildStatusCard(title, sections)));
      await cardClient.sendCardToChat(config.chatId, cardId, config.receiveIdType);
      // 首屏各段随建卡实体下发：记进 lastPushed，之后只推真变了的段
      for (const section of sections) lastPushed.set(section.id, section.content);
      logger.info("状态卡片已推送", { taskId: handle.taskId, cardId });
    } catch (err) {
      cardId = undefined;
      logger.warn("状态卡片创建/发送失败（降级：只有命令回复）", { error: String(err) });
    }
    timerHandle = timers.setInterval(() => {
      void flush(false);
    }, config.flushMs);
  })();

  handle.adopt({
    dispose(): void {
      if (timerHandle !== undefined) timers.clearInterval(timerHandle);
      subscription?.dispose();
      void (async () => {
        await flush(true); // 结局态（completed/stopped）
        const card = cardId;
        const client = cardClient;
        if (card !== undefined && client !== undefined) {
          try {
            await cardOp((op) => client.setStreamingMode(card, false, op));
          } catch (err) {
            logger.warn("关闭流式模式失败（10 分钟后平台会自动关）", { error: String(err) });
          }
        }
        if (eventSource !== undefined) {
          try {
            await eventSource.close();
          } catch (err) {
            logger.warn("关闭长连接失败", { error: String(err) });
          }
        }
      })();
    },
  });
}

/** manifest 装订导出（`looonger.json` 的 frontends.feishu.module 指向这里）。
 *  配置懒加载：目录相对本文件（`<repo>/feishu.json`，可用 env FEISHU_APP_ID/SECRET 覆盖密钥）。 */
export const feishuFrontend: TaskFrontend = createFeishuFrontend({
  configPath: resolve(import.meta.dir, "../feishu.json"),
});
