import { describe, expect, test } from 'bun:test'
import { createExecutionService } from './execution-service'
import type { CommandExecutionResult } from './command-execution'

function result(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    shell: '/bin/bash',
    cwd: '/tmp/project',
    truncated: false,
    ...overrides,
  }
}

describe('runtime-neutral ExecutionService', () => {
  test('保留 injected executor 的统一结果并在完成后保留句柄快照', async () => {
    let spawnedPid: number | undefined
    const service = createExecutionService({
      execute: async (_request, _signal, onSpawn) => {
        onSpawn(1234)
        spawnedPid = 1234
        return result({ exitCode: 7, stderr: 'expected failure' })
      },
    })

    const execution = await service.execute({
      sessionId: 'session-1',
      command: 'echo ok',
      cwd: '/tmp/project',
      shell: '/bin/bash',
    })

    expect(execution.exitCode).toBe(7)
    expect(spawnedPid).toBe(1234)
    expect(execution.errorKind).toBeUndefined()
  })

  test('Given an already aborted caller When execution starts Then the underlying executor receives the aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const service = createExecutionService({ execute: async (_request, signal) => {
      expect(signal.aborted).toBe(true)
      return result({ aborted: true, exitCode: null })
    } })
    const execution = await service.execute({ sessionId: 'preabort', shell: '/bin/bash', cwd: '/tmp', command: 'fixture', signal: controller.signal, handleId: 'preabort' })
    expect(execution.aborted).toBe(true)
    expect(service.get('preabort')?.handle.status).toBe('killed')
  })

  test('Given a host observer When a process starts Then PID and streaming callbacks reach the caller', async () => {
    const events: string[] = []
    const service = createExecutionService({ execute: async (request, _signal, onSpawn) => {
      onSpawn(123)
      request.callbacks?.onStdout?.(Buffer.from('out'))
      request.callbacks?.onStderr?.(Buffer.from('err'))
      return result()
    } })
    await service.execute({ sessionId: 'observer', shell: '/bin/bash', cwd: '/tmp', command: 'fixture', handleId: 'observer', callbacks: {
      onSpawn: pid => events.push(`pid:${pid}`), onStdout: data => events.push(data.toString()), onStderr: data => events.push(data.toString()),
    } })
    expect(events).toEqual(['pid:123', 'out', 'err'])
    expect(service.get('observer')?.handle.shellPid).toBe(123)
  })

  test('Given a request WSL environment When selecting the executor Then it uses that request launcher instead of local Bash', async () => {
    const service = createExecutionService()
    const execution = await service.execute({ sessionId: 'wsl', command: 'printf should-not-run', cwd: '/tmp', shell: 'bash', launcher: 'wsl', runtimeEnv: { env: {}, shellKind: 'wsl', wslCommand: '/definitely/missing/fixture-wsl' } })
    expect(execution.errorKind).toBe('spawn_error')
    expect(execution.errorCode).toBe('ENOENT')
    expect(execution.stderr).toContain('fixture-wsl')
  })

  test('Given completed commands beyond the retention limit When archiving Then only recent snapshots remain', async () => {
    const service = createExecutionService({ maxCompletedExecutions: 1, execute: async () => result() })
    for (const handleId of ['old', 'recent']) await service.execute({ sessionId: 'retention', shell: '/bin/bash', cwd: '/tmp', command: 'fixture', handleId })
    expect(service.get('old')).toBeUndefined()
    expect(service.get('recent')?.result?.stdout).toBe('ok')
  })

  test('取消使用同一个 AbortSignal，并将取消结果保留为 killed handle', async () => {
    let aborted = false
    const service = createExecutionService({
      execute: async (_request, signal, onSpawn) => {
        onSpawn(4321)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        })
        return result({ exitCode: null, aborted: true, signal: 'SIGTERM' })
      },
    })

    const pending = service.execute({
      sessionId: 'session-2',
      handleId: 'handle-2',
      command: 'sleep 10',
      cwd: '/tmp/project',
      shell: '/bin/bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.cancel('handle-2')
    const execution = await pending

    expect(aborted).toBe(true)
    expect(execution.aborted).toBe(true)
    expect(service.get('handle-2')?.handle.status).toBe('killed')
  })
})
