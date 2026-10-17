/**
 * 兼容宿主旧入口；Claude Agent SDK 适配器的完整实现由 @profer/agent-provider-claude 维护。
 *
 * 保留此转发是为了让 agent-service、agent-orchestrator 错误处理链和既有 Electron 测试
 * 不改调用点即可切换到 provider 包；新代码请直接从 @profer/agent-provider-claude 导入。
 */
export * from '@profer/agent-provider-claude'
