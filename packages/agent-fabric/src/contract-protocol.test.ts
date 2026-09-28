/**
 * 契约测试：协议 envelope 与幂等
 * 验收点：不启动真实 Agent 也能对请求与幂等语义做契约测试。
 */

import { describe, expect, it } from 'bun:test'
import {
  IdempotencyLedger,
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolErrorCode,
  createEnvelope,
  validateEnvelope,
} from './index'

describe('协议 envelope', () => {
  it('接受当前版本的合法 envelope', () => {
    const envelope = createEnvelope({ agentId: 'hermes', instanceId: 'h1' }, 'req_1', { hello: 1 })
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(() => validateEnvelope(envelope)).not.toThrow()
  })

  it('拒绝不支持的协议版本', () => {
    const envelope = createEnvelope({ agentId: 'hermes' }, 'req_2', {})
    envelope.protocolVersion = '0.9'
    expect(() => validateEnvelope(envelope)).toThrow(ProtocolError)
    try {
      validateEnvelope(envelope)
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED)
    }
  })

  it('拒绝空 requestId（幂等依赖该字段）', () => {
    const envelope = createEnvelope({ agentId: 'hermes' }, '  ', {})
    expect(() => validateEnvelope(envelope)).toThrow(ProtocolError)
  })

  it('拒绝缺少 actor.agentId 的请求', () => {
    const envelope = createEnvelope({ agentId: '' }, 'req_3', {})
    expect(() => validateEnvelope(envelope)).toThrow(ProtocolError)
  })
})

describe('幂等账本', () => {
  it('同一 requestId 重复提交命中首次结果，不重复执行', () => {
    const ledger = new IdempotencyLedger<string>()
    expect(ledger.begin('req_a')).toBeUndefined()
    ledger.complete('req_a', 'task_1')

    const replay = ledger.begin('req_a')
    expect(replay?.status).toBe('completed')
    expect(replay?.result).toBe('task_1')
  })

  it('同一 requestId 执行中并发重试被拒绝', () => {
    const ledger = new IdempotencyLedger<string>()
    ledger.begin('req_b')
    try {
      ledger.begin('req_b')
      throw new Error('应抛出并发重试错误')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.DUPLICATE_REQUEST_IN_FLIGHT)
      expect((error as ProtocolError).retryable).toBe(true)
    }
  })

  it('执行失败 release 后允许同一 requestId 重试', () => {
    const ledger = new IdempotencyLedger<string>()
    ledger.begin('req_c')
    ledger.release('req_c')
    expect(ledger.begin('req_c')).toBeUndefined()
  })

  it('不同 requestId 互不影响', () => {
    const ledger = new IdempotencyLedger<string>()
    ledger.begin('req_d1')
    ledger.complete('req_d1', 'task_d1')
    expect(ledger.begin('req_d2')).toBeUndefined()
  })
})
