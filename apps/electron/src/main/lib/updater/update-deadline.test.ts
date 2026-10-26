import { describe, expect, test } from 'bun:test'

import { withDeadline, UpdateTimeoutError } from './update-deadline'

describe('更新超时兜底', () => {
  test('正常完成时不受截止时间影响', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1_000, '检查')).resolves.toBe('ok')
  })

  test('底层报错原样抛出，不被改写成超时', async () => {
    const failure = new Error('ECONNRESET')
    await expect(withDeadline(Promise.reject(failure), 1_000, '检查')).rejects.toBe(failure)
  })

  test('永不 settle 的请求在截止时间后失败，而不是永久挂起', async () => {
    const startedAt = Date.now()
    await expect(withDeadline(new Promise(() => {}), 30, '检查更新')).rejects.toBeInstanceOf(UpdateTimeoutError)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test('超时错误带可读的时长，短预算按毫秒表述', async () => {
    const error = await withDeadline(new Promise(() => {}), 30, '检查更新').catch((cause) => cause)
    expect(error).toBeInstanceOf(UpdateTimeoutError)
    expect((error as Error).message).toBe('检查更新超时（30ms）')
  })
})
