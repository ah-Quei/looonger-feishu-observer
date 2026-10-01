/** 飞书卡片 JSON 2.0 构造（CardKit 流式卡片）。
 *
 *  流式更新三件套（均已对官方文档核实）：
 *  1. `config.streaming_mode: true` —— 流式模式开启期间卡片/组件级 API **不受 QPS 限制**；
 *  2. `streaming_config` —— 客户端逐字上屏的频率/步长/策略（fast：旧文未上屏完直接补齐）；
 *  3. 单个 markdown 元素 `status_md` —— 流式更新接口推**全量文本**，平台算增量。
 *
 *  注意（官方限制）：
 *  - `update_multi` 必须不为 false（我们不设，默认 true）；
 *  - 卡片实体创建后**只能发送一次**、有效期 14 天；
 *  - 流式模式 10 分钟无开启动作会自动关（我们每 ≤flushMs 推一次，并容错重开）；
 *  - 卡片体积 ≤ 30KB、元素 ≤ 200（状态卡远小于此）。
 */

export const STATUS_ELEMENT_ID = "status_md";

export interface CardJson {
  readonly schema: "2.0";
  readonly header: {
    readonly title: { readonly tag: "plain_text"; readonly content: string };
    readonly template: "blue";
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
    readonly elements: readonly [
      { readonly tag: "markdown"; readonly element_id: string; readonly content: string },
    ];
  };
}

/** 初始卡片（标题 = 任务 objective 截断；正文 = 首屏状态）。 */
export function buildStatusCard(title: string, initialContent: string): CardJson {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: truncate(title, 40) || "looonger 任务" },
      template: "blue",
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
      elements: [{ tag: "markdown", element_id: STATUS_ELEMENT_ID, content: initialContent }],
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
