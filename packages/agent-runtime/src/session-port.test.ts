import { expect, test } from 'bun:test'
import type { SessionPort } from './ports'

// 这些检查由 typecheck 执行，防止未来把异步写入伪装成完成的同步操作。
function assertSynchronousContract() {
  // @ts-expect-error 会话读取必须是同步快照，不能返回 Promise。
  const read: SessionPort['getMeta'] = async () => undefined
  // @ts-expect-error 持久化返回前必须完成，禁止 Promise 被调用方忽略。
  const append: SessionPort['appendMessages'] = async () => undefined
  // @ts-expect-error 元数据持久化禁止异步完成。
  const update: SessionPort['updateMeta'] = async () => undefined
  return [read, append, update]
}
void assertSynchronousContract

test('Given a synchronous session host When a write fails Then the caller observes failure before continuing', () => {
  const host: SessionPort = {
    getMeta: () => undefined,
    updateMeta() {},
    appendMessages() { throw new Error('persist failed') },
  }
  expect(() => host.appendMessages('session', [])).toThrow('persist failed')
})
