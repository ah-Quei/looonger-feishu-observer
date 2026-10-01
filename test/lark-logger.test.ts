/** Lark SDK logger 注入单测：info/debug/trace 静默，warn/error 收编。 */
import { describe, expect, test } from "bun:test";
import { createLarkLogger } from "../src/feishu-client";
import type { FeishuLogger } from "../src/logger";

function recorder(): { logger: FeishuLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => lines.push(`${level} ${message}`);
  return {
    lines,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

describe("createLarkLogger（消灭 SDK 自带 console 噪音）", () => {
  test("info/debug/trace 全部静默——`[info]: event-dispatch is ready` 不再上屏", () => {
    const { logger, lines } = recorder();
    const lark = createLarkLogger(logger);
    lark.info("event-dispatch is ready");
    lark.info("[ws]", "receive events ... Configured in: ...");
    lark.debug("debug noise");
    lark.trace("trace noise");
    expect(lines).toEqual([]);
  });

  test("warn/error 收编进插件 logger（带 lark 前缀，非字符串参数序列化）", () => {
    const { logger, lines } = recorder();
    const lark = createLarkLogger(logger);
    lark.warn("reconnect", { attempt: 2 });
    lark.error("fatal", "boom");
    expect(lines).toEqual(['warn lark reconnect {"attempt":2}', "error lark fatal boom"]);
  });
});
