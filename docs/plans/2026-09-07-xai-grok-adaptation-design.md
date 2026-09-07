# Profer xAI / Grok 适配设计

> 设计日期：2026-09-07（GMT+8）
> 目标仓库：`/Users/mac/profer/profer-main`
> 设计状态：已实现，xAI API Key 支持官方与 Responses 中转站

## 1. 目标与边界

为 Profer 增加 xAI API Key 直连能力，同时保留现有 Grok/X 订阅 OAuth 能力。首版产品定位为：

- Chat：正式支持，优先保证聊天质量、流式输出、图片输入和推理档位。
- Agent：实验性支持，默认不进入普通 Agent 渠道选择；用户显式开启后才可使用。
- 模型：动态拉取为主，预置 `grok-4.6` 作为模型列表不可用时的兜底。
- 协议：xAI API Key 统一使用 Responses API；官方地址和 Responses 中转站只通过 Base URL 区分。Agent 使用 Pi 的 `openai-responses` transport；订阅 OAuth 继续使用 Pi 原生 `xai` provider。

本设计明确不新增 `xai-api` provider，也不重新实现 Grok 的 Agent 协议、SSE 解析、工具调用或 OAuth 刷新。

## 2. 已确认的关键事实

### Profer 当前状态

- `packages/shared/src/types/channel.ts` 已存在 `ProviderType = 'xai'`。
- `xai` 当前语义是 Grok/X 订阅 OAuth，凭据类型为 `{ access, refresh, expires }`。
- `apps/electron/src/main/lib/xai-oauth-service.ts` 已实现 device-code 登录和刷新。
- `apps/electron/src/main/lib/adapters/pi-model-registry.ts` 已通过隔离内存 CredentialStore 使用 Pi 内置 `xai` provider。
- `packages/core/src/providers/openai-responses-adapter.ts` 已具备 Responses API 的文本、图片、工具调用和 SSE 解析能力，但目前没有注册给 `xai`。
- 渠道设置、模型拉取、连接测试和 Agent 渠道资格均通过集中分支处理，新增能力需要同步覆盖这些入口。

### Pi 与 xAI 当前能力

Pi 官方 Provider 文档说明：

- `XAI_API_KEY` 对应内置 provider `xai`。
- `/login xai` 对应 xAI/Grok 订阅 OAuth。
- 两者共用 provider ID，但 API Key 和订阅 OAuth 使用不同的认证与请求路由。
- Pi 自带 xAI 模型目录；Profer 当前通过 `getModels('xai')` 使用这份目录。

xAI 官方文档说明：

- Responses API 是推荐接口，端点为 `/v1/responses`。
- 支持流式输出、图片输入、函数调用和 structured outputs。
- reasoning effort 支持 `low`、`medium`、`high`；`xhigh` 在 `grok-4.6` 及更新模型可用。
- API Key 使用 `Authorization: Bearer ...`，官方 API Base URL 为 `https://api.x.ai/v1`。

## 3. 架构设计

### 3.1 单一 provider，区分凭据模式

继续使用 `provider: 'xai'`，在 `Channel` 增加可选凭据模式字段：

```ts
credentialMode?: 'api-key' | 'oauth'
```

兼容规则：

- `provider !== 'xai'`：忽略该字段。
- `provider === 'xai'` 且明确为 `api-key`：按普通 xAI API Key 处理。
- `provider === 'xai'` 且明确为 `oauth`：按现有 OAuth 流程处理。
- 历史 `xai` 渠道缺少该字段：解密后能解析为 OAuth JSON 时视为 `oauth`，否则视为 `api-key`。

两种凭据都继续由 Electron `safeStorage` 加密后存放在 `Channel.apiKey`，任何日志、诊断和模型事实记录都不得包含明文凭据。

### 3.2 Chat 路径

在 `@profer/core` 的 provider registry 中注册：

```ts
['xai', new OpenAIResponsesAdapter('xai')]
```

这复用已有 Responses 适配器，不创建 Grok 专用协议栈。Chat Service 仍负责：

1. 从渠道配置读取并解密 API Key。
2. 使用 `channel.baseUrl`，默认值为 `https://api.x.ai/v1`。
3. 由 Responses adapter 构造 `input`、图片、工具和流式请求。
4. 由既有 SSE reader 产出文本、reasoning、工具调用和错误事件。
5. 继续使用现有消息持久化、工具循环、标题生成和 Jotai 流状态。

OAuth `xai` 渠道不应被 Chat 的通用 API Key 适配器误用。首版建议：

- API Key 模式进入 Chat 模型列表并可直接使用，Base URL 可填写官方 xAI 或 Responses 中转站地址。
- OAuth 模式保留现有 Agent/Pi 路径；Chat 如尚无安全的 Pi Chat bridge，则继续使用本地兜底标题，不把 OAuth token 伪装成 API Key。
- 不增加 `apiProtocol` 字段：xAI API Key 固定走 Responses，不支持仅有 Chat Completions 协议的中转站。

### 3.3 Agent 路径

Agent 不新增 Grok 运行时，直接复用 Pi：

- OAuth：保留现有 `buildXaiOAuthModel()`、串行 refresh 和凭据回写。
- API Key：新增 `buildXaiApiKeyModel()`，创建隔离 `ModelRuntime`，执行 `setRuntimeApiKey('xai', apiKey)`，使用 `openai-responses` transport。已知 Grok 模型复用 Pi catalog；Responses 中转站的未知模型在当前 runtime 注册保守元数据。
- 两种模式最终都使用 Pi 的模型、工具调用、压缩、重试、恢复和流式协议实现。

由于 Profer 当前的 Agent 渠道资格由 `isAgentCompatibleProvider()` 自动派生，不能直接把 `xai` 加入该集合，否则 OAuth 和 API Key 都会无条件进入普通 Agent 选择。应增加单独的显式资格判断，例如：

```ts
isAgentEnabledForChannel(channel, settings)
```

其中 `xai` 只有在渠道级实验开关开启时返回 true；其他已有 provider 保持原语义。

建议在 `Channel` 增加：

```ts
agentExperimentalEnabled?: boolean
```

默认 `false`，只对 `xai` 有效。UI 应显示“实验性 Agent”标签和单独开关，不能把它伪装成与 Claude、Pi 常规渠道等价的稳定能力。

## 4. 模型与能力策略

### 模型列表

- API Key 模式：调用 `GET {baseUrl}/models`，复用 OpenAI model response 解析；官方 xAI 和 Responses 中转站使用同一套路径推导。
- 列表结果按模型 ID 稳定排序，保留用户已手动添加的模型。
- `/models` 失败时：
  - 编辑已有渠道：保留现有模型，不覆盖用户选择。
  - 新建渠道：提供预置 `grok-4.6`，标记为预置/未验证。
  - 连接测试仍返回失败，不得因有预置模型而显示连接成功。
- Agent 模型选择优先使用 Pi `getModels('xai')` 的 catalog；用户从 API `/models` 拉取的模型如果不在 Pi catalog 中，由隔离 runtime 按 `openai-responses` 注册保守元数据，不能静默改用其他模型。

### 上下文与推理

- Chat Responses 请求使用 xAI 支持的 reasoning 字段；不得把 OpenAI Codex 专用字段或 OAuth 路由字段带入 API Key 请求。
- 共享 reasoning profile 为 xAI 模型定义 `low/medium/high/xhigh` 的映射。
- 对不支持 `xhigh` 的模型，能力查询应隐藏或降级到 `high`，不向服务端发送非法值。
- 上下文窗口、最大输出和图片能力优先采用 Pi catalog 元数据；catalog 缺失时使用保守默认值，不声称已确认的模型能力。

## 5. 错误处理

### 配置与凭据

- Base URL 为空或不是合法 HTTP(S) URL：保存前阻止。
- API Key 为空：明确提示缺少凭据。
- OAuth JSON 损坏：提示重新登录，不尝试当作 API Key 发送。

### HTTP 与协议

- `401/403`：显示“xAI API Key 无效或无权访问该模型”，不自动重试。
- `404`：显示模型或端点不存在，并保留当前模型选择。
- `429`：显示限流/额度信息，按既有有限重试策略处理。
- `5xx`、超时、SSE 中断：按现有 Chat 重试策略处理；已完成的本地工具不得重复执行。
- `response.failed`、未知或不完整工具参数：保留已收到的文本和 reasoning，结束本轮并记录脱敏诊断信息。

### 凭据安全

- 不能把 API Key 注入全局 `process.env`，避免并发会话串用。
- Agent 使用隔离 `ModelRuntime` 的 runtime key；OAuth 使用隔离 CredentialStore。
- 日志只记录 provider、模型 ID、状态码、重试次数、错误类别和耗时，不记录 Authorization、请求正文或完整服务端错误正文。

## 6. 预计改动文件

### 共享类型与能力

- `packages/shared/src/types/channel.ts`
  - 增加 `credentialMode`、`agentExperimentalEnabled`。
  - 更新 xAI 默认 URL、显示名和兼容判断。
- `packages/shared/src/types/reasoning-profile.ts`
  - 增加/修正 Grok reasoning profile 与 xhigh 能力规则。
- 可能新增 `packages/shared/src/types/channel-xai.test.ts`。

### Chat Provider

- `packages/core/src/providers/index.ts`
  - 注册 `OpenAIResponsesAdapter('xai')`。
- `packages/core/src/providers/openai-responses-adapter.ts`
  - 仅在测试暴露的协议差异确实存在时增加 xAI 分支；优先保持通用实现。
- `packages/core/src/providers/openai-responses-adapter.test.ts`
  - 增加 xAI endpoint、图片、reasoning、工具续接和失败事件测试。
- `packages/core/src/providers/url-utils.ts`
  - 如现有 Responses URL 规则不足，增加 xAI base URL 规范化测试；不新增重复 URL 函数。

### Electron 主进程

- `apps/electron/src/main/lib/channel-manager.ts`
  - xAI API Key 的连接测试、模型拉取和凭据识别。
- `apps/electron/src/main/lib/channel-url-routing.ts`
  - xAI API Key 的 base URL 推导；不影响 OAuth 渠道。
- `apps/electron/src/main/lib/adapters/pi-model-registry.ts`
  - 增加 API Key 模式的 Pi xAI 模型构建分支，复用 Pi catalog。
- `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
  - 仅补传 API Key 模式所需输入；不重写 Pi query。
- `apps/electron/src/main/lib/agent-orchestrator.ts`
  - API Key/OAuth 凭据路由和标题生成策略。
- `apps/electron/src/main/lib/agent-model-selection.ts` 或现有资格判断模块
  - 增加渠道级实验资格校验。

### Renderer 与 IPC

- `apps/electron/src/renderer/components/settings/ChannelForm.tsx`
  - 增加 xAI API Key / 订阅登录的明确入口。
  - API Key 模式默认 URL、模型拉取和预置模型状态。
  - xAI 渠道级实验 Agent 开关。
- `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
  - 展示 xAI API / OAuth 身份和实验性 Agent 标签。
- `apps/electron/src/renderer/lib/model-logo.ts`
  - xAI provider 回退到现有 Grok logo，避免使用 DefaultLogo。
- `apps/electron/src/preload/index.ts`、`apps/electron/src/main/ipc.ts`
  - 只有新增设置或凭据操作 IPC 时才同步增加；优先复用现有渠道 API。

## 7. 分阶段实施顺序

### Phase 0：基线与能力探针

- 确认当前锁定 Pi 版本的 `xai` catalog、API Key runtime key 行为和 Responses transport。
- 用脱敏 mock 验证 `setRuntimeApiKey('xai', key)` 能构建 `grok-4.6` 模型。
- 明确 Pi catalog 与 xAI `/models` 不一致时的模型元数据策略。

### Phase 1：xAI API Key Chat

- 完成类型、默认 URL、provider registry 和 Chat 连接测试。
- 完成模型拉取、预置模型兜底和设置 UI。
- 完成文本、图片、流式 reasoning、标题和普通 Chat 工具调用。
- 这一阶段不打开 Agent 实验开关。

### Phase 2：Pi Agent API Key 胶水层

- 增加隔离 runtime key 构建分支。
- 增加 API Key 模式的模型能力解析和错误分类。
- 增加渠道级实验开关和 Agent 选择过滤。
- OAuth 现有路径保持回归验证，不做无关重构。

### Phase 3：实验 Agent 验收

使用真实但可重复的本地任务集验证：

- 读取并修改小型代码文件。
- 连续两到三次工具调用。
- 工具失败后的纠错和重试。
- 上下文接近窗口后的压缩与继续。
- 中断、恢复和模型身份记录。

只有当工具错误率、重复执行率、终态成功率和用户纠正率达到预设阈值，才考虑把开关改为默认开启或加入普通 Agent 渠道资格。

## 8. BDD 验收条件

1. **API Key 识别**
   - Given xAI 渠道保存普通 API Key
   - When 主进程解析渠道凭据
   - Then 识别为 `api-key`，不触发 OAuth refresh，也不读取全局 Pi 凭据。

2. **OAuth 兼容**
   - Given 历史 xAI 渠道保存 `{ access, refresh, expires }`
   - When 应用升级并使用该渠道
   - Then 识别为 OAuth，现有登录、刷新、回写和 Agent 行为不变。

3. **Chat 请求**
   - Given xAI API Key 和 `grok-4.6`
   - When 用户发送普通消息
   - Then 请求地址为 `{baseUrl}/responses`，认证头为 Bearer API Key，响应流可正常渲染。

4. **多模态**
   - Given 用户附加图片
   - When 发送 Chat 请求
   - Then 图片编码为 Responses `input_image`，不发送 Anthropic 或 Chat Completions 图片格式。

5. **推理档位**
   - Given 用户选择 `low`、`medium`、`high` 或 `xhigh`
   - When 模型支持该档位
   - Then 请求只发送 xAI 支持的 reasoning effort；不支持时降级或隐藏，不发送非法值。

6. **模型拉取降级**
   - Given xAI `/models` 请求失败
   - When 创建新渠道
   - Then 可选择预置 `grok-4.6`，但渠道连接状态仍为未验证/失败。

7. **Agent 实验开关**
   - Given xAI 渠道的实验开关关闭
   - When 用户打开 Agent 模型选择
   - Then xAI 不出现在普通 Agent 渠道列表中。

8. **Pi API Key Agent**
   - Given xAI API Key 渠道开启实验开关，Base URL 可以是官方地址或 Responses 中转站
   - When 创建 Pi Agent 会话
   - Then 使用隔离 runtime key 和 `openai-responses` transport；未知中转模型在当前 runtime 注册，不创建新的 Grok 协议适配器。

9. **工具续接**
   - Given Responses 流返回一个或多个 function call
   - When Profer 执行工具并续接结果
   - Then 每个调用参数独立累积，已完成工具不会因网络重试重复执行。

10. **观测链路**
    - Given xAI Chat 或实验 Agent run 结束
    - When 持久化运行事实
    - Then 至少包含 provider、模型、凭据模式、终态、重试、工具错误和耗时，不包含 prompt、API Key 或完整敏感正文。

## 9. 非目标与风险

### 非目标

- 不新增 `xai-api` provider。
- 不接入第三方 `pi-xai`、`pi-grok` 或 Grok Build 扩展作为运行依赖，除非当前 Pi 原生能力经过探针确认不足。
- 不把 SuperGrok/X Premium OAuth token 当作 xAI API Key 使用。
- 不在首版承诺 xAI Agent 与 Claude Agent 同等稳定。
- 不在首版接入 Grok 图片生成、视频、语音等独立能力；这些属于独立产品能力，不应混入聊天模型适配。

### 主要风险

- Pi 版本升级可能改变 xAI catalog、API 类型或 API Key 的解析顺序，需锁版本并增加 runtime contract test。
- xAI `/models` 目录和 Pi catalog 可能存在时间差，需要清晰区分“服务端可见模型”和“Pi 已知能力模型”。
- Responses API 的 reasoning 内容、工具调用事件和多轮状态在不同 Grok 模型上可能不完全一致，必须用录制的 SSE fixture 覆盖。
- xAI API 的地区、额度和模型权限错误可能与普通认证错误混淆，连接测试需要保留状态码和错误类别。
- 当前模型事实存在 session 级与 turn 级漂移问题；实验 Agent 必须按 run/turn 记录实际模型，不得只更新 `AgentSessionMeta.modelId`。

## 10. 推荐结论

最小且正确的实现是：

> **复用 Pi 原生 `xai` provider，复用 Profer 已有 Responses Chat adapter，只补齐 API Key 凭据识别、渠道 UI、模型拉取/测试、Agent runtime key 胶水和实验性开关。**

这样可以把新增代码集中在 Profer 的产品层和适配边界，避免重复实现 Pi 已经维护的 Grok 协议能力；同时通过实验开关和 run 级观测控制 Agent 风险。