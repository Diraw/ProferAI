/**
 * Pi Agent SDK 适配器（Electron 组合根兼容入口）。
 *
 * 完整执行与转换逻辑已抽到 @profer/agent-provider-pi；桌面宿主只保留：
 * - 原导出面的兼容转发（调用方与测试无需同时大改）；
 * - 宿主事实注入（渠道账号策略 / xAI OAuth 凭据落盘）。
 *
 * 后续删除条件：agent-service 与相关调用方直接改用 provider 包、
 * 且 Electron 侧不再需要注入宿主事实时，可删除本文件与同目录 Pi 转发文件。
 */

import { PiAgentAdapter as ProviderPiAgentAdapter } from '@profer/agent-provider-pi'
import type { PiAgentAdapterPorts } from '@profer/agent-provider-pi'
import { electronPiModelRegistryHost } from './pi-model-registry-host'

export * from '@profer/agent-provider-pi'

/**
 * 桌面宿主适配器：注入 Electron 渠道账号策略。
 *
 * 未显式传入 `host` 时使用 Electron 的官方托管渠道判定与 xAI OAuth 凭据存储，
 * 保证 `new PiAgentAdapter({ commands, backgroundTasks, processRegistration })`
 * 的既有调用点行为不变。
 */
export class PiAgentAdapter extends ProviderPiAgentAdapter {
  constructor(ports: PiAgentAdapterPorts = {}) {
    super({
      ...ports,
      host: {
        ...ports.host,
        modelRegistry: ports.host?.modelRegistry ?? electronPiModelRegistryHost,
      },
    })
  }
}
