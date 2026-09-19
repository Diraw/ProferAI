import { describe, expect, test } from 'bun:test'
import { SESSION_BLOB_REFS_FIELD, readSessionBlobRefs } from '@profer/shared'
import { applyResolvedBlobMessages } from './resolved-blob-messages'

describe('完整版覆盖 · 按 uuid 替换', () => {
  test('Given 覆盖命中 uuid When 应用 Then 换成完整版且保持顺序', () => {
    const a = { uuid: 'a', value: '片段' }
    const b = { uuid: 'b', value: '片段' }
    const resolvedA = { uuid: 'a', value: '完整内容' }

    const result = applyResolvedBlobMessages([a, b], new Map([['a', resolvedA]]))

    expect(result).toEqual([resolvedA, b])
    expect(result[0]).toBe(resolvedA)
  })

  test('Given 空覆盖 When 应用 Then 返回同一个数组引用（零开销）', () => {
    const messages = [{ uuid: 'a' }]
    const result = applyResolvedBlobMessages(messages, new Map())
    expect(result).toBe(messages)
  })

  test('Given 覆盖有值但没有一条命中 When 应用 Then 数组引用不变', () => {
    // 避免下游 useMemo 无谓失效——切换会话后残留的覆盖不该让所有消息重算
    const messages = [{ uuid: 'a' }, { uuid: 'b' }]
    const result = applyResolvedBlobMessages(messages, new Map([['zzz', { uuid: 'zzz' }]]))
    expect(result).toBe(messages)
  })

  test('Given 消息没有 uuid When 应用 Then 原样保留（无法定位，不可被覆盖）', () => {
    const noUuid = { value: '片段' }
    const messages = [noUuid]
    const result = applyResolvedBlobMessages(messages, new Map([['a', { uuid: 'a' }]]))

    expect(result).toBe(messages)     // 没有任何一条命中 → 数组引用不变
    expect(result[0]).toBe(noUuid)
  })

  test('Given 覆盖值与消息是同一条对象 When 应用 Then 数组引用不变', () => {
    const message = { uuid: 'a' }
    const messages = [message]
    const result = applyResolvedBlobMessages(messages, new Map([['a', message]]))

    expect(result).toBe(messages)
    expect(result[0]).toBe(message)
  })

  test('Given 多条命中 When 应用 Then 全部替换', () => {
    const a = { uuid: 'a', value: 1 }
    const b = { uuid: 'b', value: 2 }
    const c = { uuid: 'c', value: 3 }
    const result = applyResolvedBlobMessages(
      [a, b, c],
      new Map<string, unknown>([['a', { uuid: 'a', value: 11 }], ['c', { uuid: 'c', value: 33 }]]),
    )
    expect(result).toEqual([{ uuid: 'a', value: 11 }, b, { uuid: 'c', value: 33 }])
  })
})

describe('引用表读取', () => {
  test('Given 正常引用表 When 读取 Then 逐条读出', () => {
    const message = {
      [SESSION_BLOB_REFS_FIELD]: [
        { path: 'tool_use_result.content[0].text', hash: 'sha256:aa', chars: 100, bytes: 100 },
      ],
    }
    const refs = readSessionBlobRefs(message)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.path).toBe('tool_use_result.content[0].text')
  })

  test('Given 没有引用表 When 读取 Then 空数组', () => {
    expect(readSessionBlobRefs({ type: 'user' })).toEqual([])
    expect(readSessionBlobRefs(null)).toEqual([])
    expect(readSessionBlobRefs('string')).toEqual([])
  })

  test('Given 形状不对的条目 When 读取 Then 过滤掉而不是整体失败', () => {
    const message = {
      [SESSION_BLOB_REFS_FIELD]: [
        { path: 'ok', hash: 'sha256:aa', chars: 1, bytes: 1 },
        { path: 'missing-hash' },                 // 缺 hash
        { hash: 'sha256:bb' },                    // 缺 path
        'not-an-object',
        null,
      ],
    }
    const refs = readSessionBlobRefs(message)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.path).toBe('ok')
  })

  test('Given 字段存在但不是数组 When 读取 Then 空数组', () => {
    expect(readSessionBlobRefs({ [SESSION_BLOB_REFS_FIELD]: 'oops' })).toEqual([])
    expect(readSessionBlobRefs({ [SESSION_BLOB_REFS_FIELD]: { path: 'x' } })).toEqual([])
  })
})
