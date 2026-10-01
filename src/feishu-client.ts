/** 飞书传输层：接口 + Lark 实现（CardKit REST + WSClient 长连接）。
 *
 *  **接口先行**：观察者只依赖这两个接口，测试用内存替身——飞书挂了绝不能影响任务
 *  （所有调用点都 try/catch + logger.warn，见 observer.ts）。
 *
 *  端点（官方文档已核实 2026-09）：
 *  - tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal
 *  - 创建卡片实体:     POST /open-apis/cardkit/v1/cards            {type:"card_json", data}
 *  - 发送卡片消息:     POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *  - 流式更新文本:     PUT  /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content
 *  - 更新卡片配置:     PATCH /open-apis/cardkit/v1/cards/:card_id  {settings, sequence}
 *  - 回复消息:         POST /open-apis/im/v1/messages/:message_id/reply
 */

import { randomUUID } from "node:crypto";
import { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config";
import type { FeishuLogger } from "./logger";

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

export interface FeishuCardClient {
  /** 创建卡片实体 → card_id（一个实体只能发送一次）。 */
  createCard(cardJson: string): Promise<string>;
  /** 把卡片实体发到 chat → message_id。 */
  sendCardToChat(chatId: string, cardId: string): Promise<string>;
  /** 流式更新 markdown 元素（全量文本；sequence 须严格递增）。 */
  updateElementText(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  /** 开/关流式模式（收尾必须关：开启时不能转发、不能处理卡片回调）。 */
  setStreamingMode(cardId: string, enabled: boolean, sequence: number): Promise<void>;
  /** 回复某条消息（命令确认用）。 */
  replyText(messageId: string, text: string): Promise<void>;
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
  logger: FeishuLogger,
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

    async sendCardToChat(chatId: string, cardId: string): Promise<string> {
      const res = (await authed("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      })) as { data?: { message_id?: string } };
      return res.data?.message_id ?? "";
    },

    async updateElementText(cardId, elementId, content, sequence): Promise<void> {
      await authed(
        "PUT",
        `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
        { uuid: randomUUID(), content, sequence },
      );
    },

    async setStreamingMode(cardId, enabled, sequence): Promise<void> {
      await authed("PATCH", `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
        uuid: randomUUID(),
        sequence,
        settings: JSON.stringify({ config: { streaming_mode: enabled } }),
      });
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
export function createLarkEventSource(config: FeishuConfig): FeishuEventSource {
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret });
  let onIncoming: ((msg: FeishuIncoming) => void | Promise<void>) | undefined;

  const dispatcher = new EventDispatcher({}).register({
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
