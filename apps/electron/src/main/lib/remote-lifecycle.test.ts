import { test, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { RemoteLifecycleQueue, waitForOwnedExit, closeOwnedHttp } from './remote-lifecycle'
class AsyncChild extends EventEmitter {
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; signals: Array<NodeJS.Signals | undefined> = []
  constructor(private delay: number, private ignoreTerm = false) { super() }
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); if (!this.ignoreTerm || signal === 'SIGKILL') setTimeout(() => { this.exitCode = 0; this.emit('exit', 0) }, this.delay); return true }
}
test('async owned exit is awaited, timeout kills only passed handle', async () => {
  const own = new AsyncChild(30), foreign = new AsyncChild(0); let exited = false
  const waiting = waitForOwnedExit(own as unknown as ChildProcess, 100).then(() => { exited = true })
  await Bun.sleep(5); expect(exited).toBe(false); await waiting; expect(exited).toBe(true); expect(foreign.signals).toHaveLength(0)
  const stubborn = new AsyncChild(5, true); await waitForOwnedExit(stubborn as unknown as ChildProcess, 5, 100); expect(stubborn.signals).toEqual([undefined, 'SIGKILL']); expect(foreign.signals).toHaveLength(0)
})
test('owned process that never exits rejects instead of reporting completion', async () => {
  const child = new AsyncChild(100, true); child.kill = (signal) => { child.signals.push(signal); return true }
  await expect(waitForOwnedExit(child as unknown as ChildProcess, 5, 5)).rejects.toThrow('未退出')
  expect(child.exitCode).toBeNull(); expect(child.signals).toEqual([undefined, 'SIGKILL'])
})
test('real isolated HTTP port can rebind only after close finishes', async () => {
  const old = createServer((_req, res) => res.end('test'))
  await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve))
  const port = (old.address() as { port: number }).port
  const queue = new RemoteLifecycleQueue(); const next = createServer(); const events: string[] = []
  try {
    await queue.run(async () => { await Promise.all([closeOwnedHttp(old), waitForOwnedExit(new AsyncChild(25) as unknown as ChildProcess, 100)]); events.push('closed'); await new Promise<void>((resolve, reject) => { next.once('error', reject); next.listen(port, '127.0.0.1', resolve) }); events.push('bound') })
    expect(events).toEqual(['closed', 'bound'])
  } finally { await closeOwnedHttp(old); await closeOwnedHttp(next) }
})

test('queued fast restarts preserve HTTP/exit/bind order', async () => {
  const queue = new RemoteLifecycleQueue(); const events: string[] = []
  const restart = (port: number) => queue.run(async () => { events.push(`close-${port}`); await Bun.sleep(10); events.push(`http-closed-${port}`); const child = new AsyncChild(20); await waitForOwnedExit(child as unknown as ChildProcess, 100); events.push(`exit-${port}`); events.push(`bind-${port}`) })
  await Promise.all([restart(7789), restart(7790)])
  expect(events).toEqual(['close-7789', 'http-closed-7789', 'exit-7789', 'bind-7789', 'close-7790', 'http-closed-7790', 'exit-7790', 'bind-7790'])
})
