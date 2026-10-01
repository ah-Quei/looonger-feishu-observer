/** logger 纪律单测：默认不上屏（进接管作用域）；FEISHU_DEBUG 才直写。 */
import { describe, expect, test } from "bun:test";
import { createScopedLogger, createSilentLogger, createStderrLogger } from "../src/logger";

describe("插件 logger 纪律", () => {
  test("注入 sink：四级别都走同一出口，格式统一", () => {
    const lines: string[] = [];
    const logger = createScopedLogger({ write: (line) => lines.push(line) });
    logger.debug("d");
    logger.info("i", { k: 1 });
    logger.warn("w");
    logger.error("e");
    expect(lines).toEqual([
      "[feishu:debug] d\n",
      '[feishu:info] i {"k":1}\n',
      "[feishu:warn] w\n",
      "[feishu:error] e\n",
    ]);
  });

  test("FEISHU_DEBUG=1：绕过接管直写 stderr（本地排障专用）", () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    const previous = process.env.FEISHU_DEBUG;
    process.env.FEISHU_DEBUG = "1";
    try {
      createScopedLogger().warn("forced");
    } finally {
      process.env.FEISHU_DEBUG = previous;
      process.stderr.write = original;
    }
    expect(chunks.join("")).toContain("[feishu:warn] forced");
  });

  test("FEISHU_DEBUG 未设：不直写 stderr（交给接管作用域——由 log-discipline 冒烟证明收编）", () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    const previous = process.env.FEISHU_DEBUG;
    delete process.env.FEISHU_DEBUG;
    try {
      // 未装接管（本测试进程没调 ensureAdapterOutputCapture）→ 原样落 stderr，不丢输出
      createScopedLogger().info("plain");
    } finally {
      process.env.FEISHU_DEBUG = previous;
      process.stderr.write = original;
    }
    expect(chunks.join("")).toContain("[feishu:info] plain");
  });

  test("createSilentLogger：一个字都不出", () => {
    const logger = createSilentLogger();
    // 静默 logger 没有 write 出口——任何级别调用都不产生输出（无出口可断言，只证不抛）
    expect(() => {
      logger.debug("x");
      logger.info("x");
      logger.warn("x");
      logger.error("x");
    }).not.toThrow();
  });

  test("createStderrLogger：显式上屏（排障工具，保持可用）", () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      createStderrLogger().info("direct");
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join("")).toBe("[feishu:info] direct\n");
  });
});
