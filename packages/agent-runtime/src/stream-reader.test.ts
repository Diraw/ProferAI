import { describe, expect, test } from 'bun:test'
import { createAgentStreamDrainController, readAgentStreamNext } from './stream-reader'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('runtime stream reader', () => {
  test('waits for iterator completion after result messages', async () => {
    const iterator = (async function* () {
      yield { type: 'result' }
    })()

    expect(await readAgentStreamNext(iterator, { shouldStop: () => false })).toEqual({ kind: 'message', value: { type: 'result' } })
    expect(await readAgentStreamNext(iterator, { shouldStop: () => false })).toEqual({ kind: 'done' })
  })

  test('closes a pending iterator when the host requests stop', async () => {
    const gate = deferred<IteratorResult<string>>()
    let returned = false
    const iterator = {
      next: () => gate.promise,
      return: async () => { returned = true; return { done: true, value: undefined } },
    }
    let stopped = false
    const result = readAgentStreamNext(iterator, { shouldStop: () => stopped, pollIntervalMs: 1 })
    stopped = true

    await expect(result).resolves.toEqual({ kind: 'stopped' })
    expect(returned).toBe(true)
    gate.resolve({ done: true, value: undefined })
  })

  test('preserves the stream drain state transitions for the host', () => {
    const drain = createAgentStreamDrainController()
    expect(drain.signal('result')).toBe('result_received')
    expect(drain.signal('iterator_done')).toBe('closed')
    expect(drain.signal('stop')).toBe('closed')
  })
})
