/** 飞书传输层：接口 + Lark 实现（CardKit REST + WSClient 长连接）。
 *
 *  **接口先行**：观察者只依赖这两个接口，测试用内存替身——飞书挂了绝不能影响任务
 *  （所有调用点都 try/catch + logger.warn，见 observer.ts）。
 *
 *  端点（官方文档已核实）：
 *  - tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal
 *  - 创建卡片实体:     POST /open-apis/cardkit/v1/cards            {type:"card_json", data}
 *  - 发送卡片消息:     POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *  - 流式更新文本:     PUT  /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content
 *  - 更新卡片配置:     PATCH /open-apis/cardkit/v1/cards/:card_id/settings  {settings, sequence}
 *  - 回复消息:         POST /open-apis/im/v1/messages/:message_id/reply
 */

import type { Logger as LarkLogger } from "@larksuiteoapi/node-sdk";
import { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config";
import type { FeishuLogger } from "./logger";

/** 把飞书 SDK 自带的 console logger（`[info]: …` / `[ws] … Configured in:` 那位的源头）
 *  换成静默 info/debug/trace、warn/error 收编进插件 logger——SDK 噪音永不上屏。 */
export function createLarkLogger(logger: FeishuLogger): LarkLogger {
  const text = (...msg: unknown[]): string =>
    msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ");
  return {
    error: (...msg: unknown[]) => {
      logger.error(`lark ${text(...msg)}`);
    },
    warn: (...msg: unknown[]) => {
      logger.warn(`lark ${text(...msg)}`);
    },
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
}

/** 飞书 API 业务错误（HTTP 200 但 code !== 0）。 */
export class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

/** 流式模式已关/超时（200850 超时自动关 / 300309 已关）——重开后重试即可恢复。 */
export function isStreamingClosedError(error: unknown): boolean {
  return error instanceof FeishuApiError && (error.code === 200850 || error.code === 300309);
}

/** sequence 跳号/回退（300317）：平台已收过这个号——把号让给平台，下一个号重试即可自愈。
 *  根因背景：飞书要求同一张卡片的操作 sequence **连续递增**；「失败后也 +1」会跳号，
 *  跳一次就永久对不上（平台账本永远更大）。协议的完整定义在 frontend 的 `cardOp`。 */
export function isSequenceCompareFailedError(error: unknown): boolean {
  return error instanceof FeishuApiError && error.code === 300317;
}

export interface FeishuCardClient {
  /** 创建卡片实体 → card_id（一个实体只能发送一次）。 */
  createCard(cardJson: string): Promise<string>;
  /** 把卡片实体发到目标 → message_id。
   *  `receiveIdType`：`chat_id`（群，默认）或 `open_id`（私聊： bot 直接发给某个人，不需要群）。 */
  sendCardToChat(
    target: string,
    cardId: string,
    receiveIdType?: "chat_id" | "open_id",
  ): Promise<string>;
  /** 流式更新 markdown 元素（全量文本；sequence/uuid 的协议见 CardOp 与 frontend 的 cardOp）。 */
  updateElementText(
    cardId: string,
    elementId: string,
    content: string,
    op: CardOp,
  ): Promise<void>;
  /** 开/关流式模式（收尾必须关：开启时不能转发、不能处理卡片回调）。 */
  setStreamingMode(cardId: string, enabled: boolean, op: CardOp): Promise<void>;
  /** 回复某条消息（命令确认用）。 */
  replyText(messageId: string, text: string): Promise<void>;
}

/** 一次卡片操作的身份：
 *  - `sequence`：同一张卡片的所有操作必须连续递增（官方 300317 的语义）；
 *  - `uuid`：幂等去重——重试/网络层重发时平台凭它把重复请求认成同一次操作。 */
export interface CardOp {
  readonly sequence: number;
  readonly uuid: string;
}

export interface FeishuIncoming {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderOpenId: string;
  readonly text: string;
}

export interface FeishuEventSource {
  start(onIncoming: (msg: FeishuIncoming) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// ============ Lark 实现 ============

export function createLarkCardClient(
  config: FeishuConfig,
  /** 收着不用：与 `createLarkEventSource(config, logger)` 的签名对齐（调用点统一传），
   *  传输层的失败由 frontend 的 flush 带上下文记录（element/error），这里不重复记。 */
  _logger: FeishuLogger,
): FeishuCardClient {
  let token: { value: string; expiresAtMs: number } | undefined;

  async function tenantAccessToken(): Promise<string> {
    if (token !== undefined && token.expiresAtMs > Date.now() + 60_000) return token.value;
    const res = (await request("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: config.appId,
      app_secret: config.appSecret,
    })) as { tenant_access_token?: string; expire?: number };
    if (typeof res.tenant_access_token !== "string") {
      throw new Error("[feishu] tenant_access_token 获取失败（响应缺 token）");
    }
    token = {
      value: res.tenant_access_token,
      expiresAtMs: Date.now() + (typeof res.expire === "number" ? res.expire : 7200) * 1000,
    };
    return token.value;
  }

  async function authed(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const accessToken = await tenantAccessToken();
    return request(method, path, body, { Authorization: `Bearer ${accessToken}` });
  }

  /** 统一 HTTP：JSON in/out；业务错误 → FeishuApiError（带官方 code）。 */
  async function request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: { code?: number; msg?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as { code?: number; msg?: string } & Record<string, unknown>;
    } catch {
      throw new Error(`[feishu] ${method} ${path} 返回非 JSON（HTTP ${response.status}）`);
    }
    if (response.status < 200 || response.status >= 300 || parsed.code !== 0) {
      throw new FeishuApiError(
        parsed.code ?? response.status,
        `[feishu] ${method} ${path} 失败（code=${String(parsed.code)}）：${parsed.msg ?? text.slice(0, 200)}`,
      );
    }
    return parsed;
  }

  return {
    async createCard(cardJson: string): Promise<string> {
      const res = (await authed("POST", "/open-apis/cardkit/v1/cards", {
        type: "card_json",
        data: cardJson,
      })) as { data?: { card_id?: string } };
      const cardId = res.data?.card_id;
      if (typeof cardId !== "string") throw new Error("[feishu] 创建卡片实体失败（响应缺 card_id）");
      return cardId;
    },

    async sendCardToChat(target, cardId, receiveIdType = "chat_id"): Promise<string> {
      const res = (await authed(
        "POST",
        `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          receive_id: target,
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
        },
      )) as { data?: { message_id?: string } };
      return res.data?.message_id ?? "";
    },

    async updateElementText(cardId, elementId, content, op): Promise<void> {
      await authed(
        "PUT",
        `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
        { uuid: op.uuid, content, sequence: op.sequence },
      );
    },

    async setStreamingMode(cardId, enabled, op): Promise<void> {
      await authed(
        "PATCH",
        `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
        {
          uuid: op.uuid,
          sequence: op.sequence,
          settings: JSON.stringify({ config: { streaming_mode: enabled } }),
        },
      );
    },

    async replyText(messageId, text): Promise<void> {
      await authed("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "text",
        content: JSON.stringify({ text }),
      });
    },
  };
}

/** WS 长连接事件源（免公网回调地址）。群消息默认只在 @机器人 时推送（应用权限口径）。 */
export function createLarkEventSource(config: FeishuConfig, logger?: FeishuLogger): FeishuEventSource {
  const larkLogger = logger === undefined ? undefined : createLarkLogger(logger);
  const ws = new WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    ...(larkLogger === undefined ? {} : { logger: larkLogger }),
  });
  let onIncoming: ((msg: FeishuIncoming) => void | Promise<void>) | undefined;

  const dispatcher = new EventDispatcher({
    ...(larkLogger === undefined ? {} : { logger: larkLogger }),
  }).register({
    "im.message.receive_v1": async (data) => {
      const handler = onIncoming;
      if (handler === undefined) return;
      const message = data.message;
      if (message.message_type !== "text") return; // 只接文本；图片/卡片等忽略
      let text: string;
      try {
        text = (JSON.parse(message.content) as { text?: string }).text ?? "";
      } catch {
        return;
      }
      const senderOpenId = data.sender.sender_id?.open_id;
      if (senderOpenId === undefined) return;
      // 群聊里 @机器人 会带 @_user_1 占位符——剥掉再当命令/输入解析
      const cleaned = text.replace(/@_user_\d+/g, "").trim();
      await handler({
        messageId: message.message_id,
        chatId: message.chat_id,
        senderOpenId,
        text: cleaned,
      });
    },
  });

  return {
    async start(handler): Promise<void> {
      onIncoming = handler;
      await ws.start({ eventDispatcher: dispatcher });
    },
    async close(): Promise<void> {
      onIncoming = undefined;
      ws.close({ force: true });
    },
  };
}
