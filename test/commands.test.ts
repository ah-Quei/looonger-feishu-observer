/** 命令解析单测：普通文本=人类输入；/ 开头=命令；未知命令不当输入。 */
import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/commands";

describe("parseCommand", () => {
  test("普通文本 → 人类输入（原样保留）", () => {
    expect(parseCommand("  帮我看一下 80 端口  ")).toEqual({
      kind: "human-input",
      text: "帮我看一下 80 端口",
    });
  });

  test("/status 及别名", () => {
    expect(parseCommand("/status").kind).toBe("status");
    expect(parseCommand("/STATUS").kind).toBe("status");
    expect(parseCommand("/状态").kind).toBe("status");
    expect(parseCommand("/s").kind).toBe("status");
    expect(parseCommand("/status extra words").kind).toBe("status");
  });

  test("/stop 两段式：请求 → 确认 / 取消", () => {
    expect(parseCommand("/stop").kind).toBe("stop-request");
    expect(parseCommand("/停止").kind).toBe("stop-request");
    expect(parseCommand("/stop confirm").kind).toBe("stop-confirm");
    expect(parseCommand("/确认").kind).toBe("stop-confirm");
    expect(parseCommand("/确认停止").kind).toBe("stop-confirm");
    expect(parseCommand("/cancel").kind).toBe("stop-cancel");
    expect(parseCommand("/取消").kind).toBe("stop-cancel");
  });

  test("/help 与空消息", () => {
    expect(parseCommand("/help").kind).toBe("help");
    expect(parseCommand("/？").kind).toBe("help");
    expect(parseCommand("/").kind).toBe("help");
    expect(parseCommand("   ").kind).toBe("help");
  });

  test("未知斜杠命令 → help（**不**当人类输入）", () => {
    expect(parseCommand("/tmp/x.png").kind).toBe("help");
    expect(parseCommand("/unknown-cmd").kind).toBe("help");
  });
});
