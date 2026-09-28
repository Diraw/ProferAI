# Profer Agent Fabric 设计

> 日期：2026-09-27（GMT+8）  
> 状态：架构设计已确认；Phase 0 契约层已落地（`packages/agent-fabric`，78 项契约测试通过）；Phase 1 本地 Gateway 已落地（91 项测试通过），真实模型端到端冒烟待手工验收  
> 范围：本地 Agent 节点协作、Hermes 接入、Profer-to-Profer 委派、Stable/Dev 测试闭环  
> 非范围：本次不实现代码、不定义 Profer Server 的生产部署细节

## 1. 目标

Profer 不只作为用户直接操作的桌面 Agent，也要成为一个可以被其他 Agent 派工的本地执行节点。同时，Profer 会话自身可以把子任务派给本机的另一个 Profer 实例、headless Profer 会话或开发版 Profer。

目标运行形态：

```text
Hermes / 其他外部 Agent
            |
            | 派发自然语言任务
            v
      Profer Stable
            |
            +-- 自己执行
            +-- 派给本实例 Headless Profer
            +-- 派给另一个 Profer 实例
            +-- 派给 Profer Dev
            +-- 汇总子任务结果后继续执行
```

这不是“增加一组 MCP 工具”的局部功能，而是定义一套 Agent-to-Agent 的统一任务模型：

- Hermes 派给 Profer 的任务与 Profer 派给 Profer 的任务使用同一协议；
- Stable 调 Dev 使用与未来远程调 Profer 相同的任务、事件、审批和结果路径；
- MCP、HTTP、WebSocket/SSE 都只是接入传输，不是核心模型；
- Profer 仍负责本地工作区、工具、凭据、权限和用户确认，不向外部 Agent 直接暴露 Electron IPC 或内部 service 对象。

最终产品抽象为 **Profer Agent Fabric**：一组可发现、可寻址、可派工、可委派、可审计的 Agent 节点。

## 2. 核心对象

系统包含以下对象：

| 对象 | 含义 |
|---|---|
| Agent Node | 一个可接收任务的 Agent 运行实例，例如 `profer-stable`、`profer-dev`。 |
| Agent Session | Agent Node 为执行某个任务创建的会话。 |
| Task | 一次具体工作，输入通常是自然语言目标，附带工作区、预设、约束和策略。 |
| Task Graph | 根任务与子任务组成的树或 DAG，表达依赖、并行、聚合和取消传播。 |
| Capability | Agent Node 声明的能力，例如 `workspace.write`、`test.run`、`runtime.inspect`。 |
| Policy | 任务可以使用的权限、预算、委派深度、审批和重试边界。 |
| Event | 任务生命周期、进度、审批、子任务和产物变化的可恢复事件。 |
| Artifact | 日志、截图、测试报告、补丁、差异摘要等可引用产物。 |
| Result | 结构化任务结论，必须把结论和证据分开。 |

`Task` 是系统的统一派工单位。调用方是 Hermes、Profer 当前会话还是另一个本地 Agent，不改变任务的内部结构。

## 3. Agent Node 模型

每个 Profer 进程启动后注册为一个 Agent Node。Stable、Dev、Test 不是特殊的内部模式，而是拥有不同身份、配置和能力声明的独立节点。

```json
{
  "agentId": "profer-dev",
  "displayName": "Profer 开发版",
  "instanceId": "instance_20260927_001",
  "version": "0.13.0-dev",
  "status": "online",
  "endpoint": {
    "transport": "local-http",
    "address": "127.0.0.1:48123"
  },
  "capabilities": [
    "agent.execute",
    "workspace.read",
    "workspace.write",
    "shell.run",
    "test.run",
    "artifact.create",
    "runtime.inspect"
  ],
  "workspaceBindings": ["profer-main"],
  "preset": "renderer",
  "maxConcurrency": 1,
  "policy": {
    "allowDelegation": true,
    "maxDelegationDepth": 2
  }
}
```

### 3.1 身份语义

- `agentId` 是稳定的逻辑身份，例如 `profer-dev`；用于路由和授权。
- `instanceId` 是进程本次启动的实例身份；重启后可以变化。
- `version` 用于判断能力和协议兼容性，不作为身份。
- `status` 至少包括 `online`、`busy`、`degraded`、`offline`。
- 节点注册信息不能直接授予能力；能力还必须通过调用方身份、任务策略和当前有效授权再次解析。

同一个安装可以暴露多个逻辑节点，但每个节点必须有独立的 workspace binding、数据目录、监听端口和权限策略，避免把一个进程内的配置误当成多个安全边界。

## 4. 本地拓扑与传输

本地实验场景采用 loopback 优先的拓扑：

```text
Hermes / Profer 会话 / 本地调度器
                 |
                 v
          Local Agent Gateway
          |       |       |
          v       v       v
   Profer Stable  Profer Dev  Headless Session
```

Gateway 负责：

- Agent 注册、心跳、发现和状态；
- 任务路由、排队、租约和并发限制；
- Task Graph 的父子关系、依赖和结果聚合；
- 事件持久化、订阅、断线恢复和幂等；
- 审批请求的绑定、转发和回传；
- 本地调用方认证、授权和审计；
- 任务产物索引和受控读取。

Agent Node 负责：

- 接受 Gateway 分配的任务；
- 创建或恢复 Agent Session；
- 调用现有 Agent Runtime、Skill、MCP、文件、Shell 和测试能力；
- 在 Profer 权限模型下处理审批；
- 返回进度、结构化结果和证据。

第一阶段的网络边界是只监听 `127.0.0.1`。绑定 LAN、Tailscale 或反向代理必须是显式配置，并启用独立认证策略。loopback 不等于可信：本机其他进程仍可能访问端口，所以必须有配对身份和能力授权。

传输适配层建议包括：

```text
Local HTTP + SSE/WebSocket  -> 本地调度器和自建程序
MCP adapter                 -> Hermes、Claude Code、Cursor、OpenClaw 等客户端
Future Server transport     -> Profer Server 或远程调度器
```

这些适配器都转换到同一个内部 Task Protocol，不为 MCP 单独定义一套任务状态，也不把 MCP tool call 当成任务持久化模型。

## 5. 统一 Task Protocol

核心协议需要覆盖以下操作：

```text
discover_agents
get_agent
submit_task
get_task
subscribe_task_events
list_child_tasks
cancel_task
pause_task
resume_task
answer_approval
get_result
list_artifacts
get_artifact
```

协议的请求、事件和结果都应版本化。建议使用稳定的 envelope：

```json
{
  "protocolVersion": "1.0",
  "requestId": "req_123",
  "actor": {
    "agentId": "hermes",
    "instanceId": "hermes_local_001"
  },
  "payload": {}
}
```

`requestId` 解决调用重试和幂等问题；`taskId` 标识业务任务；`eventSequence` 标识可恢复事件顺序。协议不能依赖自然语言事件文本判断任务状态。

### 5.1 任务请求

```json
{
  "taskId": "task_123",
  "parentTaskId": "task_root_001",
  "requesterAgentId": "hermes",
  "orchestratorAgentId": "profer-stable",
  "targetAgentId": "profer-dev",
  "objective": "修改登录页响应式布局并运行相关测试",
  "workspaceId": "profer-main",
  "preset": "renderer",
  "constraints": [
    "不要修改数据库",
    "不要提交 git",
    "只允许修改 renderer 目录"
  ],
  "context": {
    "files": ["apps/electron/src/renderer/pages/Login.tsx"],
    "artifactIds": ["artifact_previous_analysis"]
  },
  "policy": {
    "approvalMode": "forward_to_user",
    "allowDelegation": true,
    "maxDelegationDepth": 3,
    "maxChildren": 5,
    "timeoutSeconds": 1800,
    "workspaceMode": "single-writer"
  }
}
```

上下文必须显式传递。子 Agent 不会因为拥有 `parentTaskId` 就自动获得父会话的全部消息、文件权限、凭据或审批权限。敏感内容只通过受控引用传递，不把 API key、完整环境变量或 Electron 对象放入任务 payload。

### 5.2 状态机

```text
created
  -> queued
  -> routing
  -> accepted
  -> running
  -> delegating
  -> waiting_for_children
  -> running
  -> completed
```

异常路径：

```text
running -> waiting_for_approval -> running
running -> waiting_for_input -> running
running -> paused -> running
任何可运行状态 -> failed
任何未终态 -> cancelled
queued/running -> expired
```

任务终态至少包括 `completed`、`failed`、`cancelled`、`expired`。`waiting_for_approval` 和 `waiting_for_input` 不是失败，必须保留恢复所需的请求和上下文。

## 6. Task Graph 与委派

任务图支持父子关系和显式依赖：

```text
Root: 修改 Profer 登录页
├── Analysis Task
├── Implementation Task
│   ├── Coding Task
│   └── Unit Test Task
├── Dev Smoke Test Task
└── Review Task
```

每个子任务至少记录：

```text
parentTaskId
rootTaskId
dependsOn[]
requesterAgentId
orchestratorAgentId
targetAgentId
inheritPolicy
aggregationMode
```

`dependsOn` 用于 DAG 依赖；`parentTaskId` 用于任务树、权限继承和 UI 展示。一个子任务可以等待多个前置任务，但不能跨越不属于当前任务图的资源或审批上下文。

父任务可以：

- 同步等待一个子任务；
- 继续执行并在未来读取结果；
- 并行派发多个只读任务；
- 等待所有子任务后聚合；
- 在子任务失败后重试、换节点或终止；
- 取消自己并向下传播取消。

委派工具的语义应统一为：

```text
delegate_task
get_task_status
wait_for_task
list_child_tasks
get_task_result
cancel_task
```

Profer 当前会话调用 `delegate_task` 时，调用链是：

```text
Profer Session
  -> Agent Gateway
  -> target Agent Node
  -> target Agent Session
  -> structured Result + Evidence
  -> Gateway
  -> parent Profer Session
```

当前会话可以把子任务派给：

```text
local-headless       当前实例的无界面 Agent 会话
profer-stable        另一个稳定版实例
profer-dev           开发版实例
named-agent          本地注册表中的其他 Agent
future-remote-agent  未来远程节点
```

目标解析通过 Agent Registry 完成，不允许任务 payload 自己提供任意 URL 后绕过注册、认证和授权。

## 7. Agent 的角色

Profer 不是固定的 Worker。一个 Profer 实例按任务可扮演三种角色：

```text
Worker        接受任务并执行
Orchestrator  拆分任务并派发子任务
Reviewer      读取结果并审查
```

Hermes 通常负责更上层的产品目标和跨节点统筹；Profer 可以在代码修改、测试或诊断任务内部做局部编排。角色由任务上下文决定，不应该通过启动不同产品来硬编码。

推荐的典型分工：

```text
Hermes          产品级目标、全局依赖和汇总
Profer Stable   代码任务编排、本地上下文和结果决策
Profer Dev      开发版启动、运行验证和诊断
Profer Review   只读代码/测试审查
```

任何节点都可以继续派生任务，但必须受到 `allowDelegation`、最大深度、最大子任务数、预算和 capability grant 限制。

## 8. 权限、身份和审批

`127.0.0.1` 只解决网络可达性，不解决本机进程信任。Local Agent Gateway 必须区分调用方身份，并在每次任务提交、状态读取、产物读取和审批操作时重新解析有效权限。

建议至少有四级信任关系：

```text
same-session         同一 Profer 会话内部
same-instance        同一 Profer 进程的 headless 子任务
paired-local-agent   用户明确配对的 Hermes 等本地 Agent
untrusted-local      未配对的本地进程
```

能力拆分为独立权限，而不是给调用方一个全能 token：

```text
task.submit
task.read
task.cancel
task.delegate
task.approve
workspace.read
workspace.write
shell.run
test.run
runtime.inspect
runtime.restart
artifact.read
external.publish
```

典型的 Hermes 配对权限可以是：

```text
task.submit
task.read
task.cancel
artifact.read
```

以下能力默认不授予 Hermes：

```text
task.approve
runtime.restart
workspace.write
external.publish
```

真正能否执行还要同时满足：

```text
调用方 grant
  ∩ 目标 Agent 能力
  ∩ 任务 policy
  ∩ workspace scope
  ∩ 当前用户/系统状态
```

### 8.1 本地配对

本地 Agent 首次接入需要用户在 Profer 中批准配对，生成可撤销的调用方身份。配对记录至少包括：

```text
clientId
clientName
publicKey / credential reference
grants
createdAt
lastSeenAt
revokedAt
```

凭据不能写进任务日志、普通配置导出或自然语言上下文。撤销配对后，新的请求立即拒绝，在途任务按策略取消或降级为只读；迟到的事件和结果不能重新获得权限。

### 8.2 审批转发

高风险操作的审批归属于原始用户，而不是自动归属于父 Agent。典型链路：

```text
Profer Dev 请求发布/删除/外部发送
        -> Gateway 创建 approval_required
        -> Profer Stable 展示给用户
        -> 用户批准或拒绝
        -> Gateway 转发一次性决定
        -> Dev 继续或终止
```

审批请求必须绑定：

```text
taskId
rootTaskId
requesterAgentId
targetAgentId
workspace scope
capability
具体操作摘要
confirmation expiry
```

子 Agent 不能通过再次委派一个任务绕过父任务的审批策略。审批 token 不可跨任务、跨 Agent、跨 workspace 或跨版本重放。

## 9. Stable/Dev 开发版测试模式

开发版测试不是额外的特殊 API，而是 Agent Fabric 的标准节点协作场景：

```text
Profer Stable
  -> delegate_task(targetAgentId = "profer-dev")
  -> Profer Dev 执行启动/测试/诊断
  -> 返回运行状态、日志、截图和测试结果
```

`profer-dev` 应绑定独立运行边界：

```text
独立 agentId
独立 instanceId
独立监听端口
独立 Electron userData
独立会话/配置目录
独立日志目录
独立模型或渠道配置
独立 workspace 或 Git worktree
```

Stable 不直接读取 Dev 的内部 Electron 对象，也不通过临时 shell 命令绕过 Agent Protocol。它只能调用 Dev 公开的诊断能力，例如：

```text
runtime.health
runtime.inspect
runtime.logs
runtime.run_smoke_test
runtime.collect_artifacts
runtime.restart
```

其中 `runtime.restart`、安装、清理数据和发布等能力必须单独授权，不因目标节点也是 Profer 而默认开放。

一个完整的开发版任务可以是：

```text
“启动当前开发版，打开指定工作区，执行 renderer smoke test，
检查启动日志、console error 和关键交互，返回截图、错误和测试结果。”
```

返回结果必须带可核验证据，例如：

```json
{
  "status": "completed",
  "runtime": {
    "processStarted": true,
    "startupDurationMs": 4200,
    "endpointReady": true
  },
  "logs": {
    "errors": 0,
    "warnings": 3
  },
  "tests": {
    "passed": 12,
    "failed": 1
  },
  "artifacts": [
    "artifact_startup_log",
    "artifact_renderer_screenshot",
    "artifact_test_report"
  ],
  "changedFiles": [],
  "blockers": []
}
```

这样稳定版会话可以基于事实决定继续修复、重试、换节点或向用户报告失败，而不是从一句“测试通过”中猜测结果。

## 10. 工作区与并发

多个 Agent 可以协作，但不能无约束地同时写同一目录。工作区应声明并发模式：

```text
read-shared       多个 Agent 可读取，不能修改
single-writer     同一时间只有一个写任务
isolated-writer   每个任务使用独立 worktree/临时目录
```

建议默认规则：

- 分析、审查、日志诊断和测试任务可以在 `read-shared` 下并发；
- 需要修改源文件的任务默认使用 `single-writer`；
- Stable 调 Dev 修改代码时使用 `isolated-writer`，或明确取得同一 writer lease；
- 产物合并由用户或拥有明确 `workspace.write` 的任务执行；
- Gateway/Workspace Manager 统一持有 workspace lease，Agent 不自行判断目录是否空闲。

任务提交时应声明写意图、预期路径和冲突策略。没有写权限的 Agent 即使运行时工具支持写入，也必须在 Broker 层被拒绝。

## 11. 结果、证据与产物

Agent 必须把结论和证据分开，结果协议至少包含：

```text
summary
status
changedFiles
testResults
artifacts
blockers
nextActions
```

证据至少可以引用：

```text
executedCommands
commandExitCodes
logReferences
screenshotReferences
fileDiffReferences
runtimeEvents
```

示例：

```json
{
  "status": "completed",
  "summary": "登录页测试通过，发现一个仅在窄窗口出现的布局警告。",
  "changedFiles": [],
  "testResults": [
    {
      "command": "bun test --isolate src/login.test.ts",
      "exitCode": 0,
      "passed": 8,
      "failed": 0,
      "artifactId": "artifact_test_report"
    }
  ],
  "evidence": [
    { "type": "command", "ref": "execution_123" },
    { "type": "log", "ref": "artifact_startup_log" }
  ],
  "blockers": [],
  "nextActions": []
}
```

产物不能默认通过任意路径暴露。Gateway 只返回 artifact reference 和元数据；读取内容要再次检查调用方、任务关系、workspace scope、大小和有效期。截图、日志和测试报告应有生命周期和清理策略。

## 12. 事件流、持久化与恢复

长任务不能依赖一个持续打开的 HTTP 请求。事件流至少支持：

```text
task.created
task.accepted
task.started
task.progress
task.child_created
task.child_completed
task.approval_required
task.artifact_created
task.test_result
task.paused
task.failed
task.completed
```

每个事件带：

```text
taskId
eventId
eventSequence
occurredAt
producerAgentId
payload
```

Gateway 持久化任务元数据、状态变化、事件游标和产物索引。调用方断线后通过 `taskId + lastEventSequence` 恢复订阅；重复投递由 `eventId` 去重，任务提交由 `requestId` 幂等。

Agent 执行使用租约和心跳：

```text
task lease -> heartbeat -> lease expiration -> recovery decision
```

Agent 崩溃后，Gateway 根据任务执行阶段和写入模式判断：

```text
是否可以恢复原 session
是否可以在 clean worktree 重试
是否只能标记为 unknown
是否允许其他 Agent 接管
```

涉及文件修改的任务不能默认自动重试。每个任务需要声明：

```text
safe-to-retry
retry-with-clean-worktree
manual-review-required
not-retryable
```

父 Agent 退出后，子任务不能因此丢失。任务图和结果必须保持可查询，用户可以从 Profer UI 或已配对调用方恢复查看。

## 13. 与现有 Profer 架构的衔接

现有 Agent Runtime、协作委派、headless runner、session manager、permission service 和工作区能力是执行实现，不是新的外部协议。建议收敛方向：

```text
External MCP / HTTP / future transport
                |
                v
         Local Agent Gateway
                |
         Agent Task Protocol
                |
       +--------+---------+
       |                  |
 Headless runner     Profer instance adapter
       |                  |
 Agent Runtime       Agent Runtime
```

迁移原则：

- 保留现有 `agent-collaboration-tools` 的委派能力，但让其调用统一的 Task Protocol；
- 保留 `agent-headless-runner-registry` 管理本地 headless 生命周期；
- 由统一 Registry 管理外部 Profer 实例、headless session 和未来远程节点；
- 复用现有 permission、ask-user、exit-plan 和 session 持久化语义；
- 不让 renderer 直接持有 Gateway 的信任凭据；
- 不把外部任务协议直接绑定到 Claude SDK 或 Pi runtime，两个 runtime 通过 Agent Node adapter 接入。

现有内部 `delegate_agent` 等能力应逐步映射为协议级动作，而不是保留一套只有 Profer 内部可用的平行语义。内部 headless 委派可以走进程内 adapter，但对上仍表现为同一个 Task、Event、Approval、Artifact、Result 模型。

## 14. 远程接入预留

本次实验只做本地服务器和 loopback 连接，但协议应保留未来的远程模式：

```text
Remote Hermes / scheduler
        -> Profer Server Gateway
        -> outbound connection from Profer Desktop
        -> Agent Node adapter
```

未来远程模式新增的是：

- 账号和设备身份；
- Server-side routing；
- desktop outbound connection；
- 远程 artifact transfer；
- 断线和离线队列；
- 跨设备策略和审计。

不应重新定义 Task、Event、Approval、Result 和 Task Graph。Profer Desktop 不应为了远程接入而把本地 Agent 状态、文件权限和工具执行全部搬到 Server。

MCP 仍然只是一个客户端适配器。若 Hermes 未来原生支持 Agent-to-Agent 协议，也只需增加另一个 transport adapter。

## 15. 分阶段实施路线

### Phase 0：协议与节点边界冻结

> 实施进度（2026-09-27）：契约层已实现于 `packages/agent-fabric`（`@profer/agent-fabric`），
> 覆盖下方全部输出项；契约测试 62 项通过（`bun test packages/agent-fabric`）。
> 纯类型与纯函数，不绑定 Electron / Claude SDK / Pi runtime。

输出：

- Agent Node、Task、Task Graph、Capability、Policy、Artifact、Result 的 TypeScript 契约；
- 状态机、事件 envelope、错误码、幂等和版本策略；
- loopback Gateway 与节点注册模型；
- Stable/Dev profile、workspace binding 和 `profer-dev` 身份规则；
- capability/readiness 表，明确哪些能力可被外部任务调用。

验收：不启动真实 Agent 也能对请求、状态迁移、事件重放、权限拒绝和任务图关系做契约测试。

### Phase 1：本地 Gateway 与现有 Headless Runner 接入

> 实施进度（2026-09-27）：已落地，91 项测试通过（`bun test packages/agent-fabric apps/electron/src/main/lib/agent-fabric`）。
> - Gateway 核心：`packages/agent-fabric/src/gateway.ts`（路由/writer lease/并发调度/幂等/孤儿任务恢复）
> - Electron 适配：`apps/electron/src/main/lib/agent-fabric/`（配置/配对/文件持久化/headless 执行器/HTTP+SSE 传输）
> - 启用：`PROFER_AGENT_FABRIC=1` 或配置目录 `agent-fabric.json` `enabled=true`；正式版端口 4788、开发版 4789，只监听 127.0.0.1
> - 配对：`node scripts/agent-fabric-pair.mjs --name <名称>`（应用内配对审批 UI 属 Phase 4）
> - 客户端参考：`node scripts/agent-fabric-client.mjs --token <TOKEN> --objective "..."`
> - 已知缺口：审批转发（`waiting_for_approval` + 一次性 token 承接）留待 Phase 2/4；暂以 headless 无人值守先例（bypassPermissions）执行，高风险操作审批链未接通

输出：

- 仅监听 `127.0.0.1` 的 Local Agent Gateway；
- Profer 实例注册、心跳、发现和状态；
- `submit_task`、`get_task`、事件订阅、取消和结果查询；
- 将现有 headless runner 接入 Task Protocol；
- 本地调用方配对和最小 grant。

验收：外部本地客户端可以提交自然语言任务，Profer 执行并返回结构化结果、事件和产物引用；断线重连不重复执行。

### Phase 2：Profer-to-Profer 委派与任务图

输出：

- `delegate_task` 和子任务关系；
- `dependsOn`、并行、等待、取消传播和结果聚合；
- 委派深度、子任务数、超时和预算限制；
- task policy 的继承和收窄规则；
- Profer 会话中的子任务视图和结果回写。

验收：Stable 会话可以派给另一个 headless 或已注册 Profer，父任务能等待并消费子任务结果；子任务不能扩大父权限。

### Phase 3：Stable/Dev 开发版测试闭环

输出：

- `profer-dev` 独立 profile、端口、日志和会话目录；
- runtime health、日志、smoke test 和 artifact collector 能力；
- 开发版启动/重启授权；
- isolated worktree 或 writer lease；
- 失败、崩溃、截图和测试报告回传。

验收：Stable 会话可以派发“启动开发版并执行 smoke test”，得到可定位的日志、截图、测试结果和失败原因。

### Phase 4：Hermes 与其他外部 Agent 适配

输出：

- MCP adapter；
- HTTP/SSE 或 WebSocket 客户端/服务端文档；
- 配对、撤销、能力 grant UI；
- 外部调用方的任务、审批和产物查询；
- 安全审计和调用方隔离。

验收：Hermes 可以以配对身份发现目标节点、提交自然语言任务、订阅进度、读取结果并处理审批，不需要知道 Profer 内部 Electron/SDK 实现。

### Phase 5：远程 Profer Server transport

输出：

- Server Gateway 和设备 outbound connection；
- 账号/设备认证、离线队列和跨设备路由；
- 远程产物和事件传输；
- 远程策略、审计和撤销。

验收：远程调度器可以复用本地任务协议向在线 Profer Desktop 派工；本地与远程的权限、审批、恢复语义一致。

## 16. 风险与明确非目标

### 风险

- 任务委派形成无限递归：用深度、节点数、预算和超时硬限制；
- 多节点同时改同一工作区：用 writer lease 或 isolated worktree；
- 本机恶意/误配置 Agent 访问 loopback：配对、短期凭据、grant 和审计；
- 断线后重复执行副作用：request 幂等、任务租约、重试分类；
- 子任务绕过父任务权限：策略只能继承或收窄，不能扩大；
- 大量日志和截图挤爆会话上下文：结果引用 artifact，按需读取；
- Stable 直接操纵 Dev 内部导致实现耦合：一律通过 Agent Protocol 能力；
- 把 MCP 当核心导致未来 transport 受限：MCP 仅作为 adapter。

### 非目标

- 不让外部 Agent 直接取得 Profer 的 Electron IPC、Node `process`、SDK session 或模型密钥；
- 不把 Gateway 变成绕过 Profer 用户权限的超级进程；
- 不允许普通 task capability 自动获得 `runtime.restart`、发布、删除或外部发送能力；
- 不在第一阶段建设云端市场、跨组织计费或复杂调度算法；
- 不要求所有节点都拥有相同模型、预设、工具和 workspace 权限。

## 17. 设计结论

Profer 的正确对外产品单位不是“工具”，而是“可寻址 Agent”。

```text
Agent Endpoint = 节点入口
Task Protocol   = 统一派工协议
Task Graph      = 任务组织方式
Capability      = 节点能力声明
Policy          = 权限与预算边界
Event Stream    = 实时进度与断线恢复
Artifact       = 结果与证据传递
Gateway         = 本地/远程路由层
```

Hermes 是第一个外部统筹 Agent；Profer Stable、Profer Dev 和 Profer Headless Session 都是同一个 Agent Fabric 中的节点。

必须保持的架构原则：

1. 外部 Agent 和 Profer 内部 Agent 走同一套任务协议。
2. Stable 调 Dev 走与未来远程调 Profer 相同的路径。
3. MCP 是接入方式，不是核心架构。
4. Profer 保留本地执行、权限、审批和证据责任。
5. 子任务可以复用能力，但不能扩大父任务授权。
6. 任务状态、事件、结果和产物必须可持久化、可恢复、可审计。
