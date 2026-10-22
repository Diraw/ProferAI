/** 兼容旧 Electron 入口；准备流程实际实现位于宿主无关 runtime。 */
export {
  createAgentQueryPreparationPort as createElectronQueryPreparationPort,
  type AgentQueryPreparationOptions as ElectronQueryPreparationOptions,
} from '@profer/agent-runtime'
