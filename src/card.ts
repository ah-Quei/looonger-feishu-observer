/** 飞书卡片 JSON 2.0 构造（CardKit 流式卡片）。
 *
 *  流式更新三件套（均已对官方文档核实）：
 *  1. `config.streaming_mode: true` —— 流式模式开启期间卡片/组件级 API **不受 QPS 限制**；
 *  2. `streaming_config` —— 客户端逐字上屏的频率/步长/策略（fast：旧文未上屏完直接补齐）；
 *  3. **按段多个 markdown 元素**（status-model 的 `StatusSection`）——流式更新接口按
 *     `element_id` 推**该段的全量文本**，平台算增量。分段 = 局部刷新：每次 flush 只推
 *     内容变化的段；某段失败/被平台清空，其他段照常显示——卡片不会整块消失。
 *
 *  注意（官方限制）：
 *  - `update_multi` 必须不为 false（我们不设，默认 true）；
 *  - 卡片实体创建后**只能发送一次**、有效期 14 天；
 *  - 流式模式 10 分钟无开启动作会自动关（我们每 ≤flushMs 推一次，并容错重开）；
 *  - 卡片体积 ≤ 30KB、元素 ≤ 200（状态卡远小于此）；
 *  - 流式更新接口：content 长度 1~100000、element_id ≤ 20 字符（空段用占位空格，
 *    见 status-model 的 `EMPTY_SECTION`）；sequence 须跨所有卡片操作严格递增。
 *
 *  正文表现力（每段一个 markdown 元素，官方能力边界）：
 *  - 不用表格：飞书表每表最多 5 行、格子窄，左右对开会把交接截成看不懂的碎片；
 *  - `<font color='…'>`：颜色枚举（red/green/blue/orange/purple/grey…）→ 现场标题/水位/告警；
 *  - 引用（`>`）放任务本身，分隔线切开「上下文 / 交接 / 进展」；
 *  - 流式更新是**按段全量替换**：渲染器每次输出该段完整 markdown，平台按 print_* 自己算增量。
 */

import type { StatusSection } from "./status-model";

export interface CardJson {
  readonly schema: "2.0";
  readonly header: {
    readonly title: { readonly tag: "plain_text"; readonly content: string };
    readonly template: "wathet";
  };
  readonly config: {
    readonly streaming_mode: true;
    readonly summary: { readonly content: string };
    readonly streaming_config: {
      readonly print_frequency_ms: { readonly default: number };
      readonly print_step: { readonly default: number };
      readonly print_strategy: "fast";
    };
  };
  readonly body: {
    /** 按段拆分（顺序 = `StatusSection` 顺序）——每段独立流式更新（局部刷新）。 */
    readonly elements: readonly {
      readonly tag: "markdown";
      readonly element_id: string;
      readonly content: string;
    }[];
  };
}

/** 初始卡片（标题 = 任务 objective 截断；正文 = 首屏各段，一段一个 markdown 元素）。 */
export function buildStatusCard(title: string, sections: readonly StatusSection[]): CardJson {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: truncate(title, 40) || "looonger 任务" },
      template: "wathet",
    },
    config: {
      streaming_mode: true,
      summary: { content: "looonger 运行状态" },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: sections.map((section) => ({
        tag: "markdown" as const,
        element_id: section.id,
        content: section.content,
      })),
    },
  };
}

/** 卡片 JSON 字符串（cardkit 创建实体接口的 `data` 字段要的是转义后的字符串）。 */
export function cardJsonString(card: CardJson): string {
  return JSON.stringify(card);
}

function truncate(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}
