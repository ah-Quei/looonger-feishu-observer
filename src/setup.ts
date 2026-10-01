#!/usr/bin/env bun
/** 一键授权向导：`bun run setup`。
 *
 *  把「装飞书应用」这件必须人工的事压到最短，其余全自动：
 *
 *   第 1 步（一次性人工，约 3 分钟）：控制台建应用/开机器人/开权限/配长连接事件/
 *          登记重定向 URL/发布版本——脚本自动打开后台并逐项清单化；
 *   第 2 步（一键）：脚本起本地回调服务 + 自动打开授权链接，浏览器点「授权」即回；
 *   第 3 步（全自动）：授权码 → user_access_token → 你的 open_id（写进 allowedSenders）
 *          → 拉你所在的群列表（选一个即 chatId）→ 尝试把机器人拉进该群；
 *   第 4 步（自动）：写 feishu.json（保留无关字段，旧文件备份）；
 *   第 5 步（自动）：发一张测试卡片到目标群，验收「                                           」。
 *
 *  飞书没有开放「创建应用」API，所以第 1 步省不掉——但只需做一次。
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { AUTHORIZE_SCOPES, buildAuthorizeUrl, parseCallback } from "./setup-lib";
import type { FeishuConfig } from "./config";

const PORT = 8972;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const CONFIG_FILE = resolve(import.meta.dir, "../feishu.json");
const CALLBACK_TIMEOUT_MS = 180_000;
const CONSOLE_URL = "https://open.feishu.cn/app";

// ---------- 终端小工具 ----------

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, fallback = ""): Promise<string> {
  return new Promise((resolvePromise) => {
    const suffix = fallback.length > 0 ? `（回车沿用 ${fallback}）` : "";
    rl.question(`${question}${suffix}: `, (answer) => resolvePromise(answer.trim() === "" ? fallback : answer.trim()));
  });
}

function line(char = "─", width = 64): string {
  return char.repeat(width);
}

function step(index: number, total: number, title: string): void {
  console.log(`\n${line("═")}\n 第 ${index}/${total} 步：${title}\n${line("═")}`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* 打不开就算了——链接已打印，用户可手动复制 */
  }
}

// ---------- 飞书 REST 小客户端（向导专用，不复用 observer 的传输层） ----------

interface FeishuResponse {
  code: number;
  msg?: string;
  [key: string]: unknown;
}

async function feishuRequest(
  base: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<FeishuResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const parsed = (await response.json()) as FeishuResponse;
  if (parsed.code !== 0) {
    throw new Error(`飞书接口 ${path} 失败（code=${parsed.code}）：${parsed.msg ?? "未知错误"}`);
  }
  return parsed;
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  console.log("looonger 飞书观察面 · 一键授权向导");
  console.log(`配置文件：${CONFIG_FILE}`);

  // 已有配置 → 各项默认值沿用
  let existing: FeishuConfig | undefined;
  if (existsSync(CONFIG_FILE)) {
    try {
      existing = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as FeishuConfig;
      console.log("检测到已有 feishu.json——未填项将沿用旧值。");
    } catch {
      console.log("已有 feishu.json 但不是合法 JSON——本向导将整体重写（旧文件会备份）。");
    }
  }
  const baseUrl = existing?.baseUrl ?? "https://open.feishu.cn";

  // ── 第 1 步：一次性人工清单 ─────────────────────────────────────────────
  step(1, 5, "创建飞书应用（一次性人工，做完从此不再需要）");
  console.log(`即将打开开发者后台：${CONSOLE_URL}`);
  console.log(`
请依次完成（每项一行，做完打勾）：
  [ ] 1. 创建企业自建应用（名字随意，如 looonger-observer）
  [ ] 2. 「添加应用能力」→ 添加「机器人」
  [ ] 3. 权限管理 → 开通：
         im:message                    发消息 / 回复
         cardkit:card:write            创建与更新卡片
         ${AUTHORIZE_SCOPES[0]}              授权后自动发现你的群
         ${AUTHORIZE_SCOPES[1]}    授权后自动拉机器人进群
  [ ] 4. 事件订阅 → 订阅方式选「使用长连接接收事件」→ 添加事件 im.message.receive_v1
  [ ] 5. 安全设置 → 重定向 URL 添加：${REDIRECT_URI}
  [ ] 6. 版本管理与发布 → 创建版本并发布（自建应用不发布不可用！）
`);
  openBrowser(CONSOLE_URL);
  const appId = await ask("粘贴 App ID（cli_ 开头）", existing?.appId ?? "");
  if (appId.length === 0) fail("缺少 App ID");
  const appSecret = await ask("粘贴 App Secret", existing?.appSecret ?? "");
  if (appSecret.length === 0) fail("缺少 App Secret");

  // ── 第 2 步：浏览器授权 ────────────────────────────────────────────────
  step(2, 5, "浏览器授权（一键）");
  const state = randomUUID();
  const authorizeUrl = buildAuthorizeUrl({
    appId,
    redirectUri: REDIRECT_URI,
    scopes: AUTHORIZE_SCOPES,
    state,
    baseUrl,
  });
  console.log("即将打开授权页，请在网页里点击「授权」：");
  console.log(`  ${authorizeUrl}\n`);
  console.log("（如果浏览器没自动打开，手动复制上面的链接）");
  openBrowser(authorizeUrl);

  const callback = await waitForCallback(state);
  if (callback.kind === "denied") fail("你拒绝了授权——重跑 `bun run setup` 再试一次");
  if (callback.kind === "invalid") fail("回调参数校验失败（state 不匹配或链接损坏）");
  const code = callback.code;

  // ── 第 3 步：授权码 → 身份 / 群 / 拉群 ─────────────────────────────────
  step(3, 5, "自动补齐配置（身份 / 群 / 拉机器人进群）");
  const tokenRes = await feishuRequest(baseUrl, "POST", "/open-apis/authen/v2/oauth/token", {
    body: {
      grant_type: "authorization_code",
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: REDIRECT_URI,
    },
  });
  const userToken = tokenRes.access_token as string;

  // 3a. 授权者本人 → allowedSenders
  let openId: string | undefined;
  try {
    const me = await feishuRequest(baseUrl, "GET", "/open-apis/authen/v1/user_info", {
      token: userToken,
    });
    openId = (me.data as { open_id?: string } | undefined)?.open_id;
  } catch (err) {
    console.log(`⚠️  读取授权者身份失败（${String(err)}）——allowedSenders 需手工填。`);
  }

  // 3b. 授权者所在的群 → chatId（不含单聊；单聊目标见 README 手工方式）
  const chatsRes = await feishuRequest(baseUrl, "GET", "/open-apis/im/v1/chats?page_size=100", {
    token: userToken,
  });
  const chats = ((chatsRes.data as { items?: Array<{ chat_id: string; name?: string }> } | undefined)
    ?.items ?? []) as Array<{ chat_id: string; name?: string }>;

  let chatId = existing?.chatId ?? "";
  if (chats.length === 0) {
    console.log("⚠️  没拉到任何群（可能没开 im:chat:readonly 或你不在任何群里）。");
    chatId = await ask("手工粘贴目标 chat_id（oc_ 开头）", chatId);
  } else if (chats.length === 1) {
    const only = chats[0];
    if (only !== undefined) {
      chatId = only.chat_id;
      console.log(`你只有一个群，已自动选中：${nameOf(only)}`);
    }
  } else {
    console.log("选择要推送状态卡的群：");
    chats.forEach((chat, index) => console.log(`  ${index + 1}) ${nameOf(chat)}`));
    const pick = await ask("输入编号", "1");
    const chosen = chats[Number(pick) - 1];
    if (chosen === undefined) fail("无效的编号");
    chatId = chosen.chat_id;
  }
  if (chatId.length === 0) fail("没有目标 chat_id");

  // 3c. 把机器人拉进选中的群（无权限/失败 → 提示手工，不阻断）
  try {
    await feishuRequest(
      baseUrl,
      "POST",
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=app_id`,
      { body: { id_list: [appId] }, token: userToken },
    );
    console.log("机器人已拉进目标群 ✓");
  } catch (err) {
    console.log(`⚠️  自动拉群失败（${String(err)}）——请手动把机器人拉进该群。`);
  }

  // ── 第 4 步：写 feishu.json ────────────────────────────────────────────
  step(4, 5, "写入配置");
  const config: FeishuConfig = {
    ...(existing ?? {}),
    appId,
    appSecret,
    chatId,
    allowedSenders: openId === undefined ? (existing?.allowedSenders ?? []) : [openId],
    baseUrl,
  } as FeishuConfig;
  if (existsSync(CONFIG_FILE)) await rename(CONFIG_FILE, `${CONFIG_FILE}.bak`);
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`已写入 ${CONFIG_FILE}（权限 600；旧文件备份为 feishu.json.bak）`);
  if (openId !== undefined) console.log(`授权者已加入白名单：${openId}`);

  // ── 第 5 步：联通性验证 ────────────────────────────────────────────────
  step(5, 5, "联通性验证（往目标群发一张测试卡片）");
  const tenant = await feishuRequest(baseUrl, "POST", "/open-apis/auth/v3/tenant_access_token/internal", {
    body: { app_id: appId, app_secret: appSecret },
  });
  const tenantToken = tenant.tenant_access_token as string;
  const cardJson = JSON.stringify({
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "looonger 联调测试" }, template: "green" },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "test_md",
          content:
            "**连接成功** ✅\n\n这是 looonger 飞书观察面的测试卡片。\n在任务群里发送 `/help` 查看命令。",
        },
      ],
    },
  });
  const card = await feishuRequest(baseUrl, "POST", "/open-apis/cardkit/v1/cards", {
    body: { type: "card_json", data: cardJson },
    token: tenantToken,
  });
  const cardId = (card.data as { card_id?: string } | undefined)?.card_id ?? "";
  await feishuRequest(baseUrl, "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    body: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    },
    token: tenantToken,
  });
  console.log("测试卡片已发送——去飞书群确认是否收到「looonger 联调测试」。");
  console.log("\n✅ 授权完成。启动方式：");
  console.log("   bun run <looonger>/apps/cli/src/index.ts -d " + dirname(CONFIG_FILE) + ' -o "<目标>" -c <目录>');
  console.log("   （或在 looonger 的 looonger.json 里配 \"domain\" 指向本目录，免每次 -d）");
  rl.close();
}

function nameOf(chat: { chat_id: string; name?: string }): string {
  return chat.name !== undefined && chat.name.length > 0 ? chat.name : chat.chat_id;
}

/** 起本地回调服务等授权码（只认本进程 state；超时/端口占用明确报错）。 */
async function waitForCallback(state: string): Promise<
  | { kind: "code"; state: string; code: string }
  | { kind: "denied"; state: string | undefined }
  | { kind: "invalid" }
> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/callback") {
          return new Response("Not Found", { status: 404 });
        }
        const result = parseCallback(request.url, state);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(result);
          setTimeout(() => void server.stop(true), 50);
        }
        const html =
          result.kind === "code"
            ? "<h2>✅ 授权成功，请回到终端</h2>"
            : result.kind === "denied"
              ? "<h2>已拒绝授权，请回到终端重试</h2>"
              : "<h2>回调异常（state 不匹配），请回到终端重试</h2>";
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void server.stop(true);
      rejectPromise(new Error(`等待授权超时（${CALLBACK_TIMEOUT_MS / 1000}s 无人完成）`));
    }, CALLBACK_TIMEOUT_MS);
  });
}

function fail(message: string): never {
  console.error(`\n❌ ${message}`);
  rl.close();
  process.exit(1);
}

try {
  await main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  rl.close();
  process.exit(1);
}
