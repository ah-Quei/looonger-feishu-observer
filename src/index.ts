/** looonger-feishu-observer 公共出口（独立仓库，只依赖 looonger-sdk 的公共观察面）。 */

export {
  buildStatusCard,
  cardJsonString,
  STATUS_ELEMENT_ID,
  type CardJson,
} from "./card";
export { FEISHU_HELP_TEXT, parseCommand, type FeishuCommand } from "./commands";
export {
  envOverrides,
  FEISHU_CONFIG_DEFAULTS,
  loadFeishuConfig,
  type FeishuConfig,
} from "./config";
export {
  createLarkCardClient,
  createLarkEventSource,
  createLarkLogger,
  FeishuApiError,
  isStreamingClosedError,
  type FeishuCardClient,
  type FeishuEventSource,
  type FeishuIncoming,
} from "./feishu-client";
export { createSilentLogger, createScopedLogger, createStderrLogger, debugForced, type FeishuLogger, type LoggerOptions } from "./logger";
export {
  createFeishuObserver,
  feishuObserver,
  type FeishuHandleView,
  type FeishuObserverOptions,
} from "./observer";
export {
  ingestStatus,
  renderStatusMarkdown,
  roleChips,
  seedStatus,
  type RenderOptions,
  type RoleChip,
  type StatusActivity,
  type StatusSnapshots,
  type StatusSource,
  type StatusState,
} from "./status-model";
