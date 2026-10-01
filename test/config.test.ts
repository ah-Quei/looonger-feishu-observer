/** 配置加载单测：缺省 / env 覆盖 / 非法值 / 空白名单语义。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeishuConfig } from "../src/config";

const tmpDirs: string[] = [];

function writeConfig(content: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "feishu-config-"));
  tmpDirs.push(dir);
  const file = join(dir, "feishu.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const BASE = {
  appId: "cli_test",
  appSecret: "secret",
  chatId: "oc_test",
  allowedSenders: ["ou_a"],
};

describe("loadFeishuConfig", () => {
  test("缺省字段全落地（allowedChats 空 / flushMs 2000 / queueTail 3 / showBoard / 60s 确认窗）", async () => {
    const config = await loadFeishuConfig(writeConfig(BASE), {});
    expect(config).toEqual({
      appId: "cli_test",
      appSecret: "secret",
      chatId: "oc_test",
      allowedSenders: ["ou_a"],
      allowedChats: [],
      receiveIdType: "chat_id",
      baseUrl: "https://open.feishu.cn",
      flushMs: 2000,
      queueTail: 3,
      showBoard: true,
      stopConfirmWindowMs: 60000,
    });
  });

  test("env 覆盖密钥（配置文件可不放 secret）", async () => {
    const file = writeConfig({ ...BASE, appSecret: "" });
    const config = await loadFeishuConfig(file, {
      FEISHU_APP_ID: "cli_env",
      FEISHU_APP_SECRET: "env-secret",
    });
    expect(config.appId).toBe("cli_env");
    expect(config.appSecret).toBe("env-secret");
  });

  test("必填缺失 / 类型错误 → 明确抛错（不静默）", async () => {
    await expect(loadFeishuConfig(writeConfig({ appSecret: "s", chatId: "c" }), {})).rejects.toThrow(
      /appId/,
    );
    await expect(
      loadFeishuConfig(writeConfig({ ...BASE, allowedSenders: "ou_a" }), {}),
    ).rejects.toThrow(/allowedSenders/);
    await expect(loadFeishuConfig(writeConfig({ ...BASE, flushMs: 0 }), {})).rejects.toThrow(/flushMs/);
    await expect(loadFeishuConfig(writeConfig({ ...BASE, showBoard: "yes" }), {})).rejects.toThrow(
      /showBoard/,
    );
  });

  test("allowedSenders 为空 = fail-closed（可加载，指令全拒）", async () => {
    const config = await loadFeishuConfig(writeConfig({ ...BASE, allowedSenders: [] }), {});
    expect(config.allowedSenders).toEqual([]);
  });

  test("receiveIdType：缺省 chat_id；私聊模式填 open_id（卡片只发本人）", async () => {
    expect((await loadFeishuConfig(writeConfig(BASE), {})).receiveIdType).toBe("chat_id");
    const dm = await loadFeishuConfig(
      writeConfig({ ...BASE, chatId: "ou_me", receiveIdType: "open_id" }),
      {},
    );
    expect(dm.receiveIdType).toBe("open_id");
    await expect(
      loadFeishuConfig(writeConfig({ ...BASE, receiveIdType: "email" }), {}),
    ).rejects.toThrow(/receiveIdType/);
  });

  test("文件不存在 → 抛错（路径错要早炸）", async () => {
    await expect(loadFeishuConfig("/nonexistent/feishu.json", {})).rejects.toThrow(/读取失败/);
  });
});
