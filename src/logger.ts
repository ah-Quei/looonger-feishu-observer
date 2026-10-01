/** 插件自带的最小日志面（不依赖 looonger 的 Logger 类型——独立仓库，锁最小耦合）。
 *
 *  **纪律（与 looonger 库层同口径）**：插件绝不往屏幕直闯。
 *  - `createScopedLogger()`（默认）：经 `@looonger/harness` 的 raw-output 接管作用域写
 *    stderr——真实宿主（looonger CLI/TUI）里这些话被 ALS 收编进**任务诊断日志**
 *    `<dataDir>/<taskId>.log.jsonl`，**永不上屏**（raw 记录不过 writeLine）；
 *    无宿主接管时（独立跑 / 测试）落 stderr，不丢输出。
 *  - `FEISHU_DEBUG=1`：绕过接管直写 stderr（本地排障专用）。
 *  - `createSilentLogger()`：一个字都不要。
 */

import { inAdapterOutputScope } from "@looonger/harness";

export interface FeishuLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface LoggerOptions {
  /** 覆盖写出口（测试 / 宿主注入；给了就不碰 stderr 与作用域）。 */
  readonly write?: (line: string) => void;
}

/** 排障开关：FEISHU_DEBUG=1 → 绕过接管直写 stderr。 */
export function debugForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FEISHU_DEBUG;
  return value === "1" || value === "true";
}

export function createScopedLogger(options: LoggerOptions = {}): FeishuLogger {
  const forced = debugForced();
  const write =
    options.write ??
    ((line: string): void => {
      if (forced) {
        process.stderr.write(line);
        return;
      }
      // 进适配器接管作用域：宿主已装 raw-output 收口 → 只进诊断日志；未装 → 原样落 stderr
      inAdapterOutputScope(() => {
        process.stderr.write(line);
      });
    });
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: unknown): void => {
      write(
        `[feishu:${level}] ${message}${meta === undefined ? "" : ` ${JSON.stringify(meta)}`}\n`,
      );
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** 静默 logger（测试 / 明确不想看日志的场景）。 */
export function createSilentLogger(): FeishuLogger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/** 强制上屏 logger（只用于本地排障；正常路径请用 createScopedLogger）。 */
export function createStderrLogger(): FeishuLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: unknown): void => {
      process.stderr.write(
        `[feishu:${level}] ${message}${meta === undefined ? "" : ` ${JSON.stringify(meta)}`}\n`,
      );
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}
