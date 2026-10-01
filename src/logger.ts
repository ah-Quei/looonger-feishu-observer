/** 插件自带的最小日志面（不依赖 looonger 的 Logger 类型——独立仓库，锁最小耦合）。
 *  默认实现写 stderr；宿主可注入自己的（CLI/TUI 组装时传 client 的 logger 亦可）。 */

export interface FeishuLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createStderrLogger(): FeishuLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: unknown): void => {
      const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
      process.stderr.write(`[feishu:${level}] ${message}${suffix}\n`);
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

/** 静默 logger（测试 / 明确不想看日志的场景）。 */
export function createSilentLogger(): FeishuLogger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
