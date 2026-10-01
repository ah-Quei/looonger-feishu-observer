/** feishu.json 加载与校验（插件自有配置；密钥可被 env 覆盖，配置文件只放非密字段）。
 *
 *  与 looonger 的 `looonger.json` 完全解耦：本文件不认识 looonger 的任何概念，
 *  只描述「飞书机器人怎么连、往哪推、谁能指挥」。
 */

import { readFile } from "node:fs/promises";

export interface FeishuConfig {
  /** 飞书自建应用 App ID。 */
  readonly appId: string;
  /** 飞书自建应用 App Secret。 */
  readonly appSecret: string;
  /** 状态卡片推送目标（群 chat_id 或用户 open_id——receive_id_type 固定 chat_id）。 */
  readonly chatId: string;
  /** 可发「人类输入 / 命令」的发送者 open_id 白名单。
   *  **空数组 = 拒绝一切指令**（fail-closed：人类输入会 steer 真 agent，不是演示功能）。 */
  readonly allowedSenders: readonly string[];
  /**  chat 白名单（空 = 不按 chat 过滤，只认发送者白名单）。 */
  readonly allowedChats: readonly string[];
  /** API 域名（默认 https://open.feishu.cn；Lark 国际版用 https://open.larksuite.com）。 */
  readonly baseUrl: string;
  /** 卡片刷新间隔 ms（脏标记 + 定时 drain；默认 2000）。 */
  readonly flushMs: number;
  /** 每队列展示的最近消息条数（默认 3，与 looonger TUI 右栏一致）。 */
  readonly queueTail: number;
  /** 是否展示 GOAL/BOARD 区（默认 true）。 */
  readonly showBoard: boolean;
  /** `/stop` 两段式确认窗口 ms（默认 60000）。 */
  readonly stopConfirmWindowMs: number;
}

export const FEISHU_CONFIG_DEFAULTS = {
  allowedSenders: [] as readonly string[],
  allowedChats: [] as readonly string[],
  baseUrl: "https://open.feishu.cn",
  flushMs: 2000,
  queueTail: 3,
  showBoard: true,
  stopConfirmWindowMs: 60_000,
} as const;

/** env 覆盖（密钥不落文件）：FEISHU_APP_ID / FEISHU_APP_SECRET。 */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): {
  appId?: string;
  appSecret?: string;
} {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  return {
    ...(appId !== undefined && appId.length > 0 ? { appId } : {}),
    ...(appSecret !== undefined && appSecret.length > 0 ? { appSecret } : {}),
  };
}

function assertNonEmptyString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[feishu] 配置文件 ${file} ${field} 应为非空字符串`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string, file: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`[feishu] 配置文件 ${file} ${field} 应为字符串数组`);
  }
  return value as readonly string[];
}

function assertPositiveInt(value: unknown, field: string, file: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`[feishu] 配置文件 ${file} ${field} 应为正整数`);
  }
  return value;
}

/** 从文件加载（路径由调用方给；加载期做词法校验，缺字段明确报错不静默）。 */
export async function loadFeishuConfig(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeishuConfig> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[feishu] 配置文件 ${file} 读取失败：${String(err)}`);
  }
  const overrides = envOverrides(env);
  const baseUrl =
    typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0
      ? parsed.baseUrl
      : FEISHU_CONFIG_DEFAULTS.baseUrl;
  const config: FeishuConfig = {
    appId: overrides.appId ?? assertNonEmptyString(parsed.appId, "appId", file),
    appSecret: overrides.appSecret ?? assertNonEmptyString(parsed.appSecret, "appSecret", file),
    chatId: assertNonEmptyString(parsed.chatId, "chatId", file),
    allowedSenders:
      parsed.allowedSenders === undefined
        ? FEISHU_CONFIG_DEFAULTS.allowedSenders
        : assertStringArray(parsed.allowedSenders, "allowedSenders", file),
    allowedChats:
      parsed.allowedChats === undefined
        ? FEISHU_CONFIG_DEFAULTS.allowedChats
        : assertStringArray(parsed.allowedChats, "allowedChats", file),
    baseUrl,
    flushMs:
      parsed.flushMs === undefined
        ? FEISHU_CONFIG_DEFAULTS.flushMs
        : assertPositiveInt(parsed.flushMs, "flushMs", file),
    queueTail:
      parsed.queueTail === undefined
        ? FEISHU_CONFIG_DEFAULTS.queueTail
        : assertPositiveInt(parsed.queueTail, "queueTail", file),
    showBoard:
      parsed.showBoard === undefined
        ? FEISHU_CONFIG_DEFAULTS.showBoard
        : (() => {
            if (typeof parsed.showBoard !== "boolean") {
              throw new Error(`[feishu] 配置文件 ${file} showBoard 应为布尔值`);
            }
            return parsed.showBoard;
          })(),
    stopConfirmWindowMs:
      parsed.stopConfirmWindowMs === undefined
        ? FEISHU_CONFIG_DEFAULTS.stopConfirmWindowMs
        : assertPositiveInt(parsed.stopConfirmWindowMs, "stopConfirmWindowMs", file),
  };
  if (config.allowedSenders.length === 0) {
    // 不抛错：允许「只看状态卡、不接指令」的部署形态；但 observers 应知情。
    process.stderr.write(
      "[feishu] allowedSenders 为空——人类输入与命令全部拒绝（只推状态卡，fail-closed）\n",
    );
  }
  return config;
}
