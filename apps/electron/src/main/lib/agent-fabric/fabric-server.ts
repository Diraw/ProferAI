/**
 * Agent Fabric Loopback HTTP/SSE 传输适配
 *
 * 设计文档 §4：传输只是适配器，全部请求转换到同一个内部 Task Protocol。
 * 本模块只做三件事：HTTP 路由、Bearer 认证 → CallerContext、SSE 事件转发。
 * 业务语义全在 @profer/agent-fabric 的 Gateway 里。
 *
 * 不 import electron：可直接用 bun test 起真实端口测试。
 *
 * 端点：
 *   GET  /v1/health                          健康检查（免认证）
 *   GET  /v1/agents?capability=xxx           发现在线节点
 *   POST /v1/tasks                           提交任务（body = 协议 envelope）
 *   GET  /v1/tasks/:taskId                   查询任务
 *   POST /v1/tasks/:taskId/cancel            取消任务
 *   GET  /v1/tasks/:taskId/result            查询结构化结果
 *   GET  /v1/tasks/:taskId/artifacts         列出产物引用
 *   GET  /v1/tasks/:taskId/events?after=N    SSE 订阅（先重放后实时）
 *   GET  /v1/artifacts/:artifactId           读取产物元数据（?content=1 读取内容）
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AgentFabricGateway,
  ProtocolError,
  ProtocolErrorCode,
  TrustLevel,
  type ArtifactRef,
  type CallerContext,
  type CapabilityValue,
  type ProtocolEnvelope,
  type TaskRequest,
} from '@profer/agent-fabric'

export interface FabricAuthResult {
  clientId: string
  clientName: string
  grants: CapabilityValue[]
}

export interface FabricServerDeps {
  gateway: AgentFabricGateway
  /** Bearer token → 已认证调用方；null 表示拒绝。 */
  authenticate: (token: string) => FabricAuthResult | null
  /** 产物内容读取端口（受控：Gateway 已校验 artifact.read 与有效期后才调用）。 */
  readArtifactContent?: (ref: ArtifactRef) => Promise<{ content: string; mimeType: string } | null>
  host?: string
  port?: number
}

export interface FabricServerHandle {
  /** 实际监听地址（port=0 时为系统分配端口）。 */
  address: string
  close: () => Promise<void>
}

const MAX_BODY_BYTES = 256 * 1024
const SSE_HEARTBEAT_MS = 15_000

function errorStatus(code: string): number {
  switch (code) {
    case ProtocolErrorCode.TASK_NOT_FOUND:
    case ProtocolErrorCode.AGENT_NOT_FOUND:
    case ProtocolErrorCode.ARTIFACT_NOT_FOUND:
    case ProtocolErrorCode.DEPENDENCY_NOT_FOUND:
      return 404
    case ProtocolErrorCode.CAPABILITY_DENIED:
    case ProtocolErrorCode.PAIRING_REVOKED:
    case ProtocolErrorCode.CALLER_NOT_PAIRED:
      return 403
    case ProtocolErrorCode.TASK_TERMINAL:
    case ProtocolErrorCode.WORKSPACE_CONFLICT:
    case ProtocolErrorCode.APPROVAL_REPLAY:
      return 409
    case ProtocolErrorCode.AGENT_OFFLINE:
    case ProtocolErrorCode.AGENT_BUSY:
      return 503
    case ProtocolErrorCode.APPROVAL_EXPIRED:
    case ProtocolErrorCode.ARTIFACT_EXPIRED:
      return 410
    default:
      return 400
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, requestId: string | null, error: unknown): void {
  if (error instanceof ProtocolError) {
    sendJson(res, errorStatus(error.code), { ok: false, requestId, error: error.toShape() })
    return
  }
  sendJson(res, 500, {
    ok: false,
    requestId,
    error: {
      code: ProtocolErrorCode.VALIDATION_FAILED,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  })
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      throw new ProtocolError(ProtocolErrorCode.PAYLOAD_TOO_LARGE, `请求体超过 ${MAX_BODY_BYTES} 字节上限`)
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, '请求体不是合法 JSON')
  }
}

/** 解析 Bearer token 并构建 CallerContext；失败抛 CALLER_NOT_PAIRED。 */
function requireCaller(req: IncomingMessage, authenticate: FabricServerDeps['authenticate']): CallerContext {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const client = token ? authenticate(token) : null
  if (!client) {
    throw new ProtocolError(ProtocolErrorCode.CALLER_NOT_PAIRED, '未配对或配对已撤销：请先完成本地配对')
  }
  return {
    agentId: client.clientName,
    trust: TrustLevel.PAIRED_LOCAL_AGENT,
    grants: client.grants,
  }
}

/** SSE：先按游标重放，再挂实时监听；任务到达终态后主动结束流。 */
function streamTaskEvents(
  res: ServerResponse,
  gateway: AgentFabricGateway,
  taskId: string,
  afterSequence: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const writeEvent = (event: { eventId: string; eventSequence: number; type: string; occurredAt: number; producerAgentId: string; payload: unknown }): void => {
    res.write(`id: ${event.eventSequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  // 重放（断线恢复：taskId + lastEventSequence）
  for (const event of gateway.resumeEvents(taskId, afterSequence)) {
    writeEvent(event)
    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled' || event.type === 'task.expired') {
      res.end()
      return
    }
  }

  const unsubscribe = gateway.onTaskEvent(taskId, (event) => {
    writeEvent(event)
    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled' || event.type === 'task.expired') {
      cleanup()
      res.end()
    }
  })

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`)
  }, SSE_HEARTBEAT_MS)

  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  res.on('close', cleanup)
}

export async function startFabricServer(deps: FabricServerDeps): Promise<FabricServerHandle> {
  const host = deps.host ?? '127.0.0.1'
  const port = deps.port ?? 0

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => sendError(res, null, error))
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const segments = url.pathname.split('/').filter(Boolean)
    let requestId: string | null = null

    try {
      // 健康检查免认证
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(res, 200, { ok: true, time: Date.now() })
        return
      }

      const caller = requireCaller(req, deps.authenticate)

      // GET /v1/agents
      if (req.method === 'GET' && url.pathname === '/v1/agents') {
        const capability = url.searchParams.get('capability') as CapabilityValue | null
        const agents = deps.gateway.discoverAgents(caller, capability ? { capability } : undefined)
        sendJson(res, 200, { ok: true, requestId, payload: { agents } })
        return
      }

      // /v1/tasks...
      if (segments[0] === 'v1' && segments[1] === 'tasks') {
        // POST /v1/tasks
        if (req.method === 'POST' && segments.length === 2) {
          const envelope = (await readBody(req)) as ProtocolEnvelope<TaskRequest>
          requestId = envelope?.requestId ?? null
          // actor 以认证身份为准：payload 里自称的 actor 不能冒充其他调用方。
          envelope.actor = { agentId: caller.agentId }
          const { task, deduplicated } = deps.gateway.submitTask(envelope, caller)
          sendJson(res, deduplicated ? 200 : 201, { ok: true, requestId, payload: { task, deduplicated } })
          return
        }

        const taskId = segments[2]
        if (!taskId) {
          sendJson(res, 404, { ok: false, requestId, error: { code: ProtocolErrorCode.TASK_NOT_FOUND, message: '缺少 taskId', retryable: false } })
          return
        }

        // GET /v1/tasks/:id/events?after=N（SSE）
        if (req.method === 'GET' && segments[3] === 'events') {
          // 先校验任务存在与读取权限，再升级为 SSE
          deps.gateway.getTask(caller, taskId)
          const after = Number(url.searchParams.get('after') ?? '0')
          if (!Number.isFinite(after) || after < 0) {
            throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, 'after 必须是非负整数事件序列')
          }
          streamTaskEvents(res, deps.gateway, taskId, after)
          return
        }

        // GET /v1/tasks/:id
        if (req.method === 'GET' && segments.length === 3) {
          const task = deps.gateway.getTask(caller, taskId)
          sendJson(res, 200, { ok: true, requestId, payload: { task } })
          return
        }

        // POST /v1/tasks/:id/cancel
        if (req.method === 'POST' && segments[3] === 'cancel') {
          const body = (await readBody(req)) as { requestId?: string }
          requestId = body?.requestId ?? null
          const task = deps.gateway.cancelTask(caller, taskId)
          sendJson(res, 200, { ok: true, requestId, payload: { task } })
          return
        }

        // GET /v1/tasks/:id/result
        if (req.method === 'GET' && segments[3] === 'result') {
          const result = deps.gateway.getTaskResult(caller, taskId)
          if (!result) {
            sendJson(res, 404, { ok: false, requestId, error: { code: ProtocolErrorCode.TASK_NOT_FOUND, message: `任务 ${taskId} 还没有结果`, retryable: false } })
            return
          }
          sendJson(res, 200, { ok: true, requestId, payload: { result } })
          return
        }

        // GET /v1/tasks/:id/artifacts
        if (req.method === 'GET' && segments[3] === 'artifacts') {
          const artifacts = deps.gateway.listArtifacts(caller, taskId)
          sendJson(res, 200, { ok: true, requestId, payload: { artifacts } })
          return
        }
      }

      // GET /v1/artifacts/:artifactId[?content=1]
      if (req.method === 'GET' && segments[0] === 'v1' && segments[1] === 'artifacts' && segments[2]) {
        const ref = deps.gateway.getArtifact(caller, segments[2])
        if (url.searchParams.get('content') === '1') {
          if (!deps.readArtifactContent) {
            sendJson(res, 501, { ok: false, requestId, error: { code: ProtocolErrorCode.VALIDATION_FAILED, message: '本节点不支持产物内容读取', retryable: false } })
            return
          }
          const content = await deps.readArtifactContent(ref)
          if (!content) {
            sendJson(res, 404, { ok: false, requestId, error: { code: ProtocolErrorCode.ARTIFACT_NOT_FOUND, message: `产物 ${ref.artifactId} 内容不存在`, retryable: false } })
            return
          }
          sendJson(res, 200, { ok: true, requestId, payload: { artifact: ref, content: content.content, mimeType: content.mimeType } })
          return
        }
        sendJson(res, 200, { ok: true, requestId, payload: { artifact: ref } })
        return
      }

      sendJson(res, 404, { ok: false, requestId, error: { code: ProtocolErrorCode.VALIDATION_FAILED, message: `未知端点 ${req.method} ${url.pathname}`, retryable: false } })
    } catch (error) {
      sendError(res, requestId, error)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const addressInfo = server.address()
  const actualPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port
  return {
    address: `${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
