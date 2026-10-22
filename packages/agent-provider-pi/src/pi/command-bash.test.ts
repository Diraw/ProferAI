import { describe, expect, test } from 'bun:test'
import type { CommandExecutionPort, CommandExecutionRequest, CommandExecutionResult } from '@profer/agent-runtime'
import { createPiCommandBashOperations } from './command-bash'

function result(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1, shell: '/bin/bash', cwd: '/fixture', truncated: false, ...overrides }
}
function port(execute: CommandExecutionPort['execute']): CommandExecutionPort {
  return { execute, cancel: async () => {}, get: () => undefined }
}

describe('Pi Bash command port', () => {
  test('Given an injected command host When Bash executes Then request identity, timeout, stream and spawn callbacks are preserved', async () => {
    const signal = new AbortController().signal
    const env = { FIXTURE: 'value' }
    const runtimeEnv = { env: { FIXTURE: 'runtime' }, shellKind: 'wsl' as const, wslDistro: 'Fixture' }
    const requests: CommandExecutionRequest[] = []
    const streamed: string[] = []
    const observed: string[] = []
    const completed: CommandExecutionResult[] = []
    const execution = result({ exitCode: 7, stdout: 'out', stderr: 'err' })
    const operations = createPiCommandBashOperations({
      commands: port(async request => {
        requests.push(request)
        request.callbacks?.onSpawn?.(123)
        request.callbacks?.onStdout?.(Buffer.from('out'))
        request.callbacks?.onStderr?.(Buffer.from('err'))
        return execution
      }),
      prepare: () => ({ sessionId: 'session', shell: 'wsl.exe', launcher: 'wsl', runtimeEnv }),
      callbacks: (command, cwd) => ({ onSpawn: pid => observed.push(`${command}:${cwd}:${pid}`), onStdout: data => observed.push(data.toString()), onStderr: data => observed.push(data.toString()) }),
      onResult: value => completed.push(value),
    })
    await expect(operations.exec('fixture command', '/fixture', { env, timeout: 2.5, signal, onData: data => streamed.push(data.toString()) })).resolves.toEqual({ exitCode: 7 })
    expect(requests[0]).toMatchObject({ sessionId: 'session', runtime: 'pi', command: 'fixture command', cwd: '/fixture', shell: 'wsl.exe', launcher: 'wsl', timeoutMs: 2500 })
    expect(requests[0]?.signal).toBe(signal)
    expect(requests[0]?.env).toBe(env)
    expect(requests[0]?.runtimeEnv).toBe(runtimeEnv)
    expect(streamed).toEqual(['out', 'err'])
    expect(observed).toEqual(['fixture command:/fixture:123', 'out', 'err'])
    expect(completed).toEqual([execution])
  })

  test.each([
    { changes: { aborted: true }, message: 'aborted' },
    { changes: { timedOut: true }, message: 'timeout:3' },
    { changes: { errorKind: 'shell_not_found' as const, errorCode: 'ENOENT' }, message: 'shell_not_found' },
    { changes: { errorKind: 'working_directory_error' as const }, message: 'working_directory_error' },
    { changes: { errorKind: 'spawn_error' as const, stderr: 'fixture spawn error' }, message: 'fixture spawn error' },
  ])('Given $message When execution settles Then evidence is reported before the SDK error', async ({ changes, message }) => {
    const execution = result(changes)
    const evidence: CommandExecutionResult[] = []
    const operations = createPiCommandBashOperations({ commands: port(async () => execution), prepare: () => ({ sessionId: 's', shell: '/bin/bash' }), onResult: value => evidence.push(value) })
    await expect(operations.exec('fixture', '/fixture', { timeout: 3, onData() {} })).rejects.toThrow(message)
    expect(evidence).toEqual([execution])
  })

  test('Given a rejected path preparation When starting Then no command reaches the host', async () => {
    let executed = false
    const operations = createPiCommandBashOperations({ commands: port(async () => { executed = true; return result() }), prepare() { throw new Error('path denied') } })
    await expect(operations.exec('fixture', '/fixture', { onData() {} })).rejects.toThrow('path denied')
    expect(executed).toBe(false)
  })
})
