/** 命令解析（纯函数）：飞书消息 → 插件动作。
 *
 *  设计口径：
 *  - 普通文本 = 人类输入（喂给 strategist 审查队列，与 TUI 输入同一条路）；
 *  - `/` 开头 = 命令，**未知命令不当人类输入**（避免把 `/tmp/x.png` 这种内容喂给 agent）；
 *  - 中文别名并列（状态/停止/确认/取消/帮助），命令大小写不敏感。
 */

export type FeishuCommand =
  | { readonly kind: "human-input"; readonly text: string }
  | { readonly kind: "status" }
  | { readonly kind: "stop-request" }
  | { readonly kind: "stop-confirm" }
  | { readonly kind: "stop-cancel" }
  | { readonly kind: "help" };

const COMMAND_ALIASES: Record<string, FeishuCommand["kind"]> = {
  status: "status",
  s: "status",
  状态: "status",
  stop: "stop-request",
  停止: "stop-request",
  "stop-confirm": "stop-confirm",
  confirm: "stop-confirm",
  确认: "stop-confirm",
  确认停止: "stop-confirm",
  cancel: "stop-cancel",
  取消: "stop-cancel",
  help: "help",
  h: "help",
  "?": "help",
  "？": "help",
  帮助: "help",
};

export function parseCommand(raw: string): FeishuCommand {
  const text = raw.trim();
  if (text.length === 0) return { kind: "help" };
  const isCommand = text.startsWith("/") || text.startsWith("／");
  if (!isCommand) return { kind: "human-input", text };
  const body = text.slice(1).trim();
  if (body.length === 0) return { kind: "help" };
  const words = body.split(/\s+/);
  const first = (words[0] ?? "").toLowerCase();
  const second = words[1]?.toLowerCase();
  // 两词命令用连字符归一（`/stop confirm` ≡ `/stop-confirm`）；两词未命中再回退首词
  const twoWord = second === undefined ? undefined : `${first}-${second}`;
  const kind =
    (twoWord === undefined ? undefined : COMMAND_ALIASES[twoWord]) ?? COMMAND_ALIASES[first];
  if (kind === undefined) return { kind: "help" };
  return { kind } as FeishuCommand;
}

/** `/help` 的回复文案（与 README 命令表同源——改一处）。 */
export const FEISHU_HELP_TEXT = [
  "looonger 飞书观察面：",
  "· 直接发文本 = 人类输入（进 strategist 审查队列）",
  "· /status（/状态）— 立即刷新状态卡片",
  "· /stop（/停止）— 请求停止（需 60s 内 /stop confirm 确认）",
  "· /cancel（/取消）— 取消待确认的停止请求",
  "· /help（/帮助）— 本帮助",
].join("\n");
