/** 授权向导的纯函数件（可单测）：授权链接构造 / 回调解析 / scope 清单。
 *
 *  飞书 OAuth 2.0 授权码流程（端点 2026-09 核实）：
 *  - 授权页：`{accounts 域名}/open-apis/authen/v1/authorize`
 *    （`client_id` + `response_type=code` + `redirect_uri` + `scope` + `state`）
 *  - 换 token：`{open 域名}/open-apis/authen/v2/oauth/token`（authorization_code）
 *  - 重定向 URL 必须登记在应用「安全设置」里；官方示例即使用 localhost 回调
 */

/** 授权链接申请的 scope（必须在控制台「权限管理」先开通，否则用户看到 20027）。
 *  - `im:chat:readonly`：授权后拉「我所在的群」→ 自动发现 chatId；
 *  - `im:chat.members:write_only`：授权后把机器人拉进选中的群（无权限则跳过并提示手工拉）。
 *  用户身份（open_id）由 user_info 端点直接取，不需要额外 scope。 */
export const AUTHORIZE_SCOPES = ["im:chat:readonly", "im:chat.members:write_only"] as const;

/** open.feishu.cn ↔ accounts.feishu.cn（授权页在 accounts 域；Lark 国际版同理）。 */
export function accountsBaseUrl(openBaseUrl: string): string {
  return openBaseUrl.replace("//open.", "//accounts.");
}

export interface AuthorizeUrlOptions {
  readonly appId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  /** open 域 base（默认 https://open.feishu.cn；accounts 域由它推导）。 */
  readonly baseUrl?: string;
}

/** 构造授权链接（redirect_uri 与 scope 都要 URL 编码）。 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const base = accountsBaseUrl(options.baseUrl ?? "https://open.feishu.cn");
  const url = new URL(`${base}/open-apis/authen/v1/authorize`);
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  // query 里空格官方示例写作 %20（URLSearchParams 默认输出 +）——按文档来，免兼容惊喜
  return url.toString().replace(/\+/g, "%20");
}

/** 发卡片消息的路径：推送目标类型决定 `receive_id_type`（chat_id=群 / open_id=私聊）。 */
export function cardSendPath(receiveIdType: "chat_id" | "open_id"): string {
  return `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
}

export type CallbackResult =
  | { readonly kind: "code"; readonly state: string; readonly code: string }
  | { readonly kind: "denied"; readonly state: string | undefined }
  | { readonly kind: "invalid" };

/** 解析回调 URL：`?code=..&state=..` / `?error=access_denied&state=..`。 */
export function parseCallback(rawUrl: string, expectedState: string): CallbackResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "invalid" };
  }
  const state = url.searchParams.get("state") ?? undefined;
  if (state !== expectedState) return { kind: "invalid" };
  const error = url.searchParams.get("error");
  if (error === "access_denied") return { kind: "denied", state };
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) return { kind: "invalid" };
  return { kind: "code", state, code };
}
