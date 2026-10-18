/**
 * Pi provider 的权限契约别名。
 *
 * Pi adapter 只依赖 runtime 的中性权限端口类型；桌面宿主自有的
 * `agent-permission-service`（含权限 UI 队列、会话白名单）通过结构类型
 * 继续原样传入，不需要 provider 反向依赖 Electron。
 */

export type {
  RuntimeCanUseTool as PiCanUseTool,
  RuntimeCanUseToolOptions as PiCanUseToolOptions,
  RuntimePermissionResult as PiPermissionResult,
  RuntimePermissionResultMetadata as PiPermissionResultMetadata,
  RuntimePermissionUpdate as PiPermissionUpdate,
  RuntimePermissionUpdateDestination as PiPermissionUpdateDestination,
  RuntimePermissionRuleValue as PiPermissionRuleValue,
  RuntimePermissionDecisionClassification as PiPermissionDecisionClassification,
} from '@profer/agent-runtime'
