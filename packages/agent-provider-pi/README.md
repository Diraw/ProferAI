# @profer/agent-provider-pi

宿主无关的 Pi Agent SDK provider 包。完整 Pi 执行与转换逻辑（adapter、消息/SDK 转换、
模型注册、工具定义、重试与流控、Pi 专属扩展工厂）都在这里；桌面宿主只负责注入
「宿主事实」，不再把 Pi 逻辑留在 `apps/electron`。

## 边界

**provider 提供（SDK 行为 + 通用执行）**

| 模块 | 内容 |
|------|------|
| `pi-agent-adapter.ts` | `PiAgentAdapter`：完整 query 生命周期、事件流、终态、abort/interrupt、队列消息、任务查询、deferred 工具装配 |
| `pi/message-adapter.ts` | Pi ↔ SDKMessage 转换、上下文消毒、结果/错误投影 |
| `pi/model-registry.ts` | 渠道 → Pi provider 注册、API 协议/baseUrl/请求头映射、1M 上下文偏好、Codex/xAI OAuth 模型 |
| `pi/model-runtime-options.ts` | 隔离的 `ModelRuntime` 配置与内存凭据存储（不读 `~/.pi`） |
| `pi/prompt-chain.ts` | interrupt reservation 与续轮链 |
| `pi/retry-control.ts` / `pi/streaming-control.ts` | 原生重试终态门、partial 消息合并 |
| `pi/harness-lifecycle.ts` / `pi/command-bash.ts` / `pi/command-powershell.ts` | 生命周期映射、命令端口适配 |
| `pi/shell-execution.ts` / `pi/powershell-tool.ts` | 本地/WSL/Git-Bash/PowerShell 进程执行与流式输出 |
| `pi/skill-resources.ts` / `pi/resource-loader-overrides.ts` / `pi/skill-slugs.ts` | Skill/AGENTS.md 加载门禁与 override |
| `pi/project-instruction.ts` / `pi/project-instruction-scope.ts` | 按访问路径解析项目指令（不越过授权项目根） |
| `pi/request-proxy.ts` | 请求代理作用域（AsyncLocalStorage + fetch 安装） |
| `pi/codex-*` / `pi/*-reasoning-request-settings.ts` | Codex/Pi 请求设置扩展工厂 |
| `pi/tool-definition-compaction.ts` | 工具定义压缩 |
| `pi/runtime-env.ts` / `pi/command-execution.ts` | 环境合并与结构化命令结果类型（宿主无关子集） |

**宿主提供（应用路径、账号策略、权限 UI、持久化、产品工具）**

- 存储与工作区路径（`piAgentDir` / `piSessionDir` / `cwd` 由调用方传入）；
- 渠道凭据解析、官方托管渠道判定、xAI OAuth 凭据落盘 → `PiProviderHostDependencies`；
- 权限 UI 与 AskUser 闭环 → `canUseTool`（runtime 中性权限类型，桌面权限服务结构兼容）；
- 持久化 → 由宿主持有 `sessionManager` 语义的会话存储，adapter 只产出 `SDKMessage`；
- 产品工具（Browser / PPT / Image / 协作委派 / 定时任务等）→ 通过 `customTools` 与
  `prepared.deferredToolAssembly` 注入，provider 不导入产品服务。

**不依赖**：`apps/electron`、`electron` 模块、产品服务与产品工具实现。

## 依赖

```
@profer/agent-runtime   runtime 契约、端口、error-patterns、runtime-guards
@profer/shared          共享类型与纯工具
@profer/core/providers  baseUrl/UA 归一化
typebox / undici        Pi 工具参数 schema、请求代理
peer: @earendil-works/pi-coding-agent / pi-ai / pi-agent-core 0.86.1
```

## 使用

```ts
import { PiAgentAdapter } from '@profer/agent-provider-pi'

const adapter = new PiAgentAdapter({
  commands,             // CommandExecutionPort
  backgroundTasks,      // BackgroundTaskPort
  processRegistration,  // ProcessRegistrationPort
  host: {
    // 可选：官方托管渠道判定 / xAI OAuth 凭据记忆与刷新
    modelRegistry: electronPiModelRegistryHost,
  },
})

for await (const message of adapter.query({ /* PiAgentQueryOptions */ })) { /* ... */ }
```

未注入 `host.modelRegistry` 时行为与 runtime 原默认值一致（不做官方渠道特判、不落盘 OAuth 凭据），
因此非 Electron 宿主可以零宿主事实启动。

## 验证

```bash
cd packages/agent-provider-pi
bun run typecheck
bun test --isolate                    # 迁移后的 helper 测试 + 最小 runner
bun test/minimal-pi-runner.ts         # 直接跑非 Electron 生命周期验证
```

`test/minimal-pi-runner.ts` 使用**真实 Pi SDK**（Session / 工具装配 / 事件流 / abort / dispose），
只把 `ModelRuntime.streamSimple` 换成脚本化传输，验证消息流、工具、取消、错误、终态与资源释放；
不发起真实模型请求，也不使用任何凭据。
