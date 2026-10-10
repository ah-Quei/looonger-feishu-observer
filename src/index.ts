/** looonger-feishu-observer 公共出口（独立仓库，只依赖 looonger-sdk 的公共观察面）。 */

export { buildStatusCard, cardJsonString, type CardJson } from "./card";
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
  createFeishuFrontend,
  feishuFrontend,
  type FeishuFrontendOptions,
  type FeishuHandleView,
  type TimerHandle,
} from "./frontend";
export {
  ingestStatus,
  renderStatusMarkdown,
  renderStatusSections,
  roleChips,
  seedStatus,
  STATUS_SECTION_IDS,
  type RenderOptions,
  type RoleChip,
  type StatusActivity,
  type StatusSection,
  type StatusSnapshots,
  type StatusSource,
  type StatusState,
} from "./status-model";
