#!/usr/bin/env node
/**
 * Agent Fabric 外部客户端示例（Hermes/调度器的最小参考实现）
 *
 * 用法：
 *   node scripts/agent-fabric-client.mjs --token <TOKEN> --objective "运行 renderer smoke test 并返回结果"
 *   node scripts/agent-fabric-client.mjs --token <TOKEN> --agents
 *   node scripts/agent-fabric-client.mjs --token <TOKEN> --task <taskId>          # 查询/追踪已有任务
 *   node scripts/agent-fabric-client.mjs --token <TOKEN> --task <taskId> --cancel
 *
 * 选项：--port 4788 | --target profer-dev | --workspace <id> | --no-wait | --after <seq>
 *
 * 演示的协议要点：
 * - 提交使用幂等 requestId（同一 requestId 重发不会重复执行）；
 * - SSE 订阅从 after 游标恢复（断线重连用最后一次收到的 id 继续）；
 * - 结果与产物分开：任务完成后读取 result 与 artifacts。
 */

import { randomUUID } from 'node:crypto'

function parseArgs(argv) {
  const args = { port: 4788, wait: true, after: 0 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--token') args.token = argv[++i]
    else if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--objective') args.objective = argv[++i]
    else if (arg === '--target') args.target = argv[++i]
    else if (arg === '--workspace') args.workspace = argv[++i]
    else if (arg === '--task') args.task = argv[++i]
    else if (arg === '--after') args.after = Number(argv[++i])
    else if (arg === '--cancel') args.cancel = true
    else if (arg === '--agents') args.agents = true
    else if (arg === '--no-wait') args.wait = false
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.token || (!args.objective && !args.task && !args.agents)) {
  console.log('用法: agent-fabric-client.mjs --token <TOKEN> (--agents | --objective "..." | --task <id> [--cancel]) [--port 4788] [--no-wait]')
  process.exit(args.help ? 0 : 1)
}

const base = `http://127.0.0.1:${args.port}`
const headers = { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' }

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = json?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`${method} ${path} 失败：${message}`)
  }
  return json.payload
}

async function streamEvents(taskId, after) {
  const res = await fetch(`${base}/v1/tasks/${taskId}/events?after=${after}`, { headers })
  if (!res.ok || !res.body) {
    throw new Error(`事件订阅失败：HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastSeq = after
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return lastSeq
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const lines = frame.split('\n')
      const idLine = lines.find((l) => l.startsWith('id: '))
      const typeLine = lines.find((l) => l.startsWith('event: '))
      const dataLine = lines.find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      lastSeq = idLine ? Number(idLine.slice(4)) : lastSeq
      const data = JSON.parse(dataLine.slice(6))
      console.log(`  [evt#${lastSeq}] ${typeLine?.slice(7) ?? ''} ${JSON.stringify(data.payload)}`)
      if (['task.completed', 'task.failed', 'task.cancelled', 'task.expired'].includes(data.type)) {
        return lastSeq
      }
    }
  }
}

async function main() {
  if (args.agents) {
    const { agents } = await call('GET', '/v1/agents')
    for (const agent of agents) {
      console.log(`${agent.agentId}  ${agent.status}  ${agent.version}  endpoint=${agent.endpoint.address ?? agent.endpoint.transport}`)
    }
    return
  }

  let taskId = args.task
  if (args.cancel) {
    const { task } = await call('POST', `/v1/tasks/${taskId}/cancel`, { requestId: randomUUID() })
    console.log(`已取消：${task.request.taskId}（${task.status}）`)
    return
  }

  if (args.objective) {
    const target = args.target ?? 'profer-stable'
    const request = {
      taskId: `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      rootTaskId: undefined,
      requesterAgentId: 'external-client',
      orchestratorAgentId: target,
      targetAgentId: target,
      objective: args.objective,
      workspaceId: args.workspace ?? 'default',
      constraints: [],
      dependsOn: [],
      policy: {
        approvalMode: 'auto_deny',
        allowDelegation: false,
        maxDelegationDepth: 0,
        maxChildren: 0,
        timeoutSeconds: 1800,
        workspaceMode: 'read-shared',
        retryClass: 'safe-to-retry',
      },
      submittedAt: Date.now(),
    }
    request.rootTaskId = request.taskId

    const requestId = randomUUID()
    const { task, deduplicated } = await call('POST', '/v1/tasks', {
      protocolVersion: '1.0',
      requestId,
      actor: { agentId: 'external-client' },
      payload: request,
    })
    taskId = task.request.taskId
    console.log(`任务已提交：${taskId}（status=${task.status}${deduplicated ? '，幂等去重' : ''}）`)
    if (!args.wait) return
  }

  console.log(`订阅事件（after=${args.after}）…断线后可用 --task ${taskId} --after <lastSeq> 恢复`)
  await streamEvents(taskId, args.after)

  const { task } = await call('GET', `/v1/tasks/${taskId}`)
  console.log(`\n终态：${task.status}${task.failureReason ? `（${task.failureReason}）` : ''}`)

  const resultRes = await fetch(`${base}/v1/tasks/${taskId}/result`, { headers })
  if (resultRes.ok) {
    const { result } = (await resultRes.json()).payload
    console.log(`\n===== 结果摘要 =====\n${result.summary}`)
    if (result.artifacts.length > 0) {
      console.log(`\n产物：${result.artifacts.map((a) => `${a.artifactId}(${a.kind})`).join(', ')}`)
    }
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
