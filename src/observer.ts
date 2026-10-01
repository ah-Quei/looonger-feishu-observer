/** 飞书观察者（TaskObserver 实现）。
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
 */

import { resolve } from "node:path";
import type { TaskObserver } from "looonger-sdk";
import type { StatusSnapshots, StatusState } from "./status-model";
import { ingestStatus, renderStatusMarkdown, seedStatus } from "./status-model";
import { parseCommand, FEISHU_HELP_TEXT } from "./commands";
import { buildStatusCard, cardJsonString, STATUS_ELEMENT_ID } from "./card";
import { loadFeishuConfig, type FeishuConfig } from "./config";
import {
  createLarkCardClient,
  createLarkEventSource,
  type FeishuCardClient,
  type FeishuEventSource,
  type FeishuIncoming,
  isStreamingClosedError,
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

export interface FeishuObserverOptions {
  /** 已加载的配置（测试/宿主直传）；与 configPath 二选一。 */
  readonly config?: FeishuConfig;
  /** feishu.json 路径（manifest 装订用；attach 时懒加载，失败 = 降级无卡片）。 */
  readonly configPath?: string;
  readonly logger?: FeishuLogger;
  readonly now?: () => number;
  readonly timers?: { setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  readonly cardClient?: FeishuCardClient;
  readonly eventSource?: FeishuEventSource;
}

export function createFeishuObserver(options: FeishuObserverOptions = {}): TaskObserver {
  const logger = options.logger ?? createScopedLogger();
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  return {
    attach(handle: TaskObserver extends never ? never : Parameters<TaskObserver["attach"]>[0]): void {
      attachFeishu(handle as unknown as FeishuHandleView, options, logger, now, timers);
    },
  };
}

function attachFeishu(
  handle: FeishuHandleView,
  options: FeishuObserverOptions,
  logger: FeishuLogger,
  now: () => number,
  timers: { setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void },
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
        dirty = true;
      } catch (err) {
        logger.warn("事件搬运失败（跳过本批）", { error: String(err) });
      }
    });
  } catch (err) {
    logger.error("订阅失败（观察者不生效）", { error: String(err) });
    return;
  }

  let dirty = true;
  let config: FeishuConfig | undefined = options.config;
  let cardClient: FeishuCardClient | undefined = options.cardClient;
  let eventSource: FeishuEventSource | undefined = options.eventSource;
  let cardId: string | undefined;
  let timerHandle: unknown;
  let sequence = 0;
  let flushing = false;
  let pendingStopAt: number | undefined;

  function renderOptions(): { queueTail: number; showBoard: boolean } {
    return {
      queueTail: config?.queueTail ?? 3,
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

  /** 唯一碰飞书卡片 IO 的地方；失败保持脏标记下轮重试，流式被关则重开后重试一次。 */
  async function flush(force: boolean): Promise<void> {
    if (cardId === undefined || cardClient === undefined) return;
    if (flushing) {
      if (force) dirty = true;
      return;
    }
    if (!dirty && !force) return;
    flushing = true;
    try {
      const text = renderStatusMarkdown(state, snapshots(), renderOptions(), now());
      sequence += 1;
      try {
        await cardClient.updateElementText(cardId, STATUS_ELEMENT_ID, text, sequence);
        dirty = false;
      } catch (err) {
        if (!isStreamingClosedError(err)) throw err;
        // 流式模式 10 分钟无操作会自动关（官方行为）：重开 + 同文本重推
        sequence += 1;
        await cardClient.setStreamingMode(cardId, true, sequence);
        await cardClient.updateElementText(cardId, STATUS_ELEMENT_ID, text, sequence);
        dirty = false;
      }
    } catch (err) {
      dirty = true;
      logger.warn("卡片更新失败（下轮重试）", { error: String(err) });
    } finally {
      flushing = false;
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
      const initial = renderStatusMarkdown(state, snapshots(), renderOptions(), now());
      const title = state.objective.length > 0 ? state.objective : `任务 ${handle.taskId}`;
      cardId = await cardClient.createCard(cardJsonString(buildStatusCard(title, initial)));
      await cardClient.sendCardToChat(config.chatId, cardId, config.receiveIdType);
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
        if (cardId !== undefined && cardClient !== undefined) {
          sequence += 1;
          try {
            await cardClient.setStreamingMode(cardId, false, sequence);
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

/** manifest 装订导出（`looonger.json` 的 observers.feishu.module 指向这里）。
 *  配置懒加载：目录相对本文件（`<repo>/feishu.json`，可用 env FEISHU_APP_ID/SECRET 覆盖密钥）。 */
export const feishuObserver: TaskObserver = createFeishuObserver({
  configPath: resolve(import.meta.dir, "../feishu.json"),
});
