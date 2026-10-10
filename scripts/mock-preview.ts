/** 静态三态预览：同一份 mock 数据（`mock-data.ts`）在三个关键时刻的定格。
 *
 *  想看它动起来：`bun run preview:live`（起本地回放服务，见 `mock-live.ts`）。
 *
 *  三个检查点（均为虚拟时刻）：
 *  ① 145s 流式更新中——SOL Saying + 停滞标记 + 上下文 48.2% + 人类输入已消费；
 *  ② 200s 审查闸 + 压缩中——pruner 上场、review held、goal blocked、strategist 92%；
 *  ③ 312s 结局——session-stopped、全 idle、outcome completed。
 */

import { buildStatusCard, cardJsonString } from "../src/card";
import { MOCK_DURATION_MS, MockWorld } from "./mock-data";

/** attach 前 12 分钟（卡片 elapsed 的原点；elapsed = 虚拟回放时长）。 */
const BASE = new Date("2026-09-15T15:18:00+08:00").getTime();

const POINTS: readonly { atMs: number; label: string; note: string }[] = [
  {
    atMs: 145_000,
    label: "① 流式更新中（145s）",
    note: "solver 在说（Saying）、停滞 Edit ×7、上下文 48.2%、人类输入已入队并消费；指令已 seen",
  },
  {
    atMs: 200_000,
    label: "② 审查闸 + 压缩中（200s）",
    note: "solver 让路 todo_done 后：live=pruner 压缩中（threshold），SOL 显示让路、review 已消费（held 窗口 151–160s）、goal blocked",
  },
  {
    atMs: MOCK_DURATION_MS,
    label: "③ 任务完成（312s）",
    note: "session-stopped(task_completed) 后全 idle；BOARD 5/5、goal complete、outcome completed、人类输入累计 2",
  },
];

for (const point of POINTS) {
  const world = new MockWorld(BASE);
  world.advanceTo(point.atMs);
  console.log(`\n${"─".repeat(72)}\n${point.label}\n${point.note}\n${"─".repeat(72)}`);
  console.log(world.markdown());
}

// ── 检查点 ① 对应的 CardKit 建卡请求体（真实传输层就发这个；一段一个 markdown 元素） ──
const at145 = new MockWorld(BASE);
at145.advanceTo(145_000);
console.log(`\n${"═".repeat(72)}\nPOST /open-apis/cardkit/v1/cards 请求体（检查点 ① 的实际 data）\n${"═".repeat(72)}`);
console.log(
  JSON.stringify(
    { type: "card_json", data: cardJsonString(buildStatusCard(at145.headerTitle(), at145.sections())) },
    null,
    2,
  ),
);

console.log("\n✅ 静态三态打印完毕。想看动起来的版本：bun run preview:live");
