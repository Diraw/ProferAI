/**
 * agent-runtime-preflight-projection 单测
 *
 * 用**真实** `SessionPort` 语义（parity 内存宿主）验证落盘顺序：
 * preflight 失败 → `[['assistant'], ['system']]`，无用户气泡，onError 文案与旧路径一致。
 */

import { describe, expect, test } from 'bun:test'
import type { TypedError } from '@profer/shared'
import {
  applyPreflightFailureProjection,
  formatTypedErrorText,
  projectPreflightFailure,
  requiresUserMessageSuppression,
} from './agent-runtime-preflight-projection'
import { createParityHost } from './runtime-migration-parity/support/parity-host'

const tokenExpired: TypedError = {
  code: 'token_expired',
  title: '团队账号登录已过期',
  message: '请重新登录团队账号后再使用 Agent 商业渠道。',
  actions: [{ key: 's', label: '打开设置', action: 'settings' }],
  canRetry: false,
}

const apiKeyDecryptFailed: TypedError = {
  code: 'api_key_decrypt_failed',
  title: 'API Key 解密失败',
  message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
  actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
  canRetry: false,
}

describe('projectPreflightFailure', () => {
  test('凭证过期：错误气泡正文与旧路径逐字一致，interruption_record 用归一化 label', () => {
    const projection = projectPreflightFailure({ typedError: tokenExpired, startedAt: 1234, now: () => 999 })
    expect(projection.errorText).toBe('团队账号登录已过期: 请重新登录团队账号后再使用 Agent 商业渠道。')
    expect(projection.suppressUserMessage).toBe(true)
    expect(projection.transcript.map(message => message.type)).toEqual(['assistant', 'system'])
    expect((projection.transcript[1] as unknown as { subtype: string }).subtype).toBe('interruption_record')
    expect((projection.transcript[1] as unknown as { message: string }).message).toBe('执行出错')
    expect(projection.fields).toEqual({ stoppedByUser: false, startedAt: 1234, endReason: 'error', endReasonLabel: '执行出错' })
    expect(projection.interruptMeta).toEqual({
      lastInterruptReason: 'error',
      lastInterruptLabel: '执行出错',
      lastInterruptAt: 999,
    })
  })

  test('错误气泡携带 TypedError 的结构化字段（渲染层据此出恢复动作）', () => {
    const bubble = projectPreflightFailure({ typedError: apiKeyDecryptFailed }).transcript[0] as unknown as Record<string, unknown>
    expect(bubble).toMatchObject({
      type: 'assistant',
      parent_tool_use_id: null,
      _errorCode: 'api_key_decrypt_failed',
      _errorTitle: 'API Key 解密失败',
      _errorCanRetry: false,
    })
    expect(bubble.error).toEqual({
      message: apiKeyDecryptFailed.message,
      errorType: 'api_key_decrypt_failed',
    })
  })

  test('无标题的 TypedError 只用消息正文（不产生 `: ` 前缀）', () => {
    expect(formatTypedErrorText({ title: '', message: '只有消息' })).toBe('只有消息')
    expect(projectPreflightFailure({ typedError: { ...tokenExpired, title: '' } }).errorText).toBe(tokenExpired.message)
  })

  test('preflight 失败必须抑制用户气泡', () => {
    expect(requiresUserMessageSuppression('preflight_failure')).toBe(true)
  })
})

describe('applyPreflightFailureProjection（真实 SessionPort 语义）', () => {
  test('落盘 transcript 与旧路径一致：[assistant, system]，无 user 气泡', () => {
    const host = createParityHost({ runtime: 'pi' })
    const projection = projectPreflightFailure({ typedError: tokenExpired, startedAt: 1 })
    const result = applyPreflightFailureProjection({
      sessions: host.sessions,
      sessionId: 'parity-session',
      projection,
    })
    expect(result).toEqual({ appended: true, metaUpdated: true, errors: [] })
    // 旧路径同一场景的 transcript（见 parity/persistence-events 的 G3 现状记录）。
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['assistant'], ['system']])
    expect(host.session.metaPatches.at(-1)).toMatchObject({
      lastInterruptReason: 'error',
      lastInterruptLabel: '执行出错',
    })
  })

  test('落盘失败不抛错，但错误被收集（不静默吞掉）', () => {
    const host = createParityHost({ runtime: 'pi', appendMessagesFailure: 'persist failed' })
    const projection = projectPreflightFailure({ typedError: tokenExpired })
    const result = applyPreflightFailureProjection({
      sessions: host.sessions,
      sessionId: 'parity-session',
      projection,
    })
    expect(result.appended).toBe(false)
    expect(result.metaUpdated).toBe(true)
    expect(result.errors[0]).toContain('persist failed')
  })

  test('顺序要求：抑制用户气泡后 transcript 才等于旧路径（证明 G3 的根因是落盘顺序）', () => {
    // 现状：coordinator 在凭证解析前落用户气泡 → 只有 [['user']]。
    const currentHost = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    currentHost.sessions.appendMessages('parity-session', [
      { type: 'user', message: { content: [] }, parent_tool_use_id: null } as never,
    ])
    expect(currentHost.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user']])

    // 目标顺序：凭证成功后才落用户消息，失败时改为 preflight transcript。
    const requiredHost = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    const projection = projectPreflightFailure({ typedError: tokenExpired, startedAt: 1 })
    expect(projection.suppressUserMessage).toBe(true)
    applyPreflightFailureProjection({ sessions: requiredHost.sessions, sessionId: 'parity-session', projection })
    expect(requiredHost.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['assistant'], ['system']])
  })
})
