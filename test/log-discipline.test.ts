/** 日志纪律端到端冒烟（子进程）：装 looonger 的 raw-output 接管后，
 *  插件 logger 的话**只进接管 sink、stderr 一个字都没有**——这就是
 *  「插件日志上屏」投诉的回归钉。 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const PROBE = `
import { ensureAdapterOutputCapture } from "@looonger/harness";
import { createScopedLogger } from "./src/logger";

const captured: string[] = [];
ensureAdapterOutputCapture({
  debug: (m, meta) => captured.push(\`debug \${m} \${JSON.stringify(meta ?? {})}\`),
  info: (m, meta) => captured.push(\`info \${m} \${JSON.stringify(meta ?? {})}\`),
  warn: (m, meta) => captured.push(\`warn \${m} \${JSON.stringify(meta ?? {})}\`),
  error: (m, meta) => captured.push(\`error \${m} \${JSON.stringify(meta ?? {})}\`),
  child: () => { throw new Error("probe 不需要 child"); },
});

const logger = createScopedLogger();
logger.info("状态卡片已推送", { cardId: "c1" });
logger.warn("卡片更新失败（下轮重试）", { error: "boom" });

await new Promise((r) => setTimeout(r, 50));
// 结果走 stdout（本行在作用域外，console.log 原样透传，不被接管）
console.log("CAPTURED " + JSON.stringify(captured));
`;

test("接管生效时：插件日志零上屏、全进接管 sink", async () => {
  // 探针必须落在插件仓库内——tsconfig paths（@looonger/harness → 源码）只在仓内生效
  const probe = join(import.meta.dir, "..", "probe-log-discipline.tmp.ts");
  await Bun.write(probe, PROBE);
  try {
    const proc = Bun.spawn(["bun", "run", probe], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FEISHU_DEBUG: undefined },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // stderr 零输出——插件的话没上屏
    expect(stderr.trim()).toBe("");

    // 接管 sink 收到了（raw 记录：stderr.write → warn 级）
    const line = stdout.split("\n").find((l) => l.startsWith("CAPTURED "));
    expect(line).toBeDefined();
    const captured = JSON.parse((line ?? "").slice("CAPTURED ".length)) as string[];
    const joined = captured.join("\n");
    expect(joined).toContain("状态卡片已推送");
    expect(joined).toContain("卡片更新失败（下轮重试）");
    expect(joined).toContain("raw output");
  } finally {
    await rm(probe, { force: true });
  }
});
