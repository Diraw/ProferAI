import { describe, expect, test } from 'bun:test'
import type { BackgroundTaskPort, CommandExecutionPort, CommandExecutionRequest, CommandExecutionResult, ProcessRegistrationPort } from '@profer/agent-runtime'
import { createPiPowerShellToolDefinition, formatPowerShellResult } from './command-powershell'

const result = (overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult => ({
  stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false,
  durationMs: 1, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cwd: 'C:\\workspace', truncated: false,
  ...overrides,
})

function tool(commands: CommandExecutionPort, extras: Partial<Parameters<typeof createPiPowerShellToolDefinition>[1]> = {}) {
  const sdk = { defineTool: (definition: unknown) => definition } as typeof import('@earendil-works/pi-coding-agent')
  return createPiPowerShellToolDefinition(sdk, {
    commands,
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    cwd: 'C:\\workspace',
    sessionId: 'session-1',
    ...extras,
  }) as unknown as { execute(id: string, params: unknown, signal: AbortSignal): Promise<{ content: Array<{ text: string }>; details: CommandExecutionResult }> }
}

describe('Pi PowerShell command port', () => {
  test('Given an injected command host When PowerShell executes Then preserves request, output and process/background lifecycle', async () => {
    const requests: CommandExecutionRequest[] = []
    const events: string[] = []
    const background: BackgroundTaskPort = {
      begin: () => events.push('begin'), append: (_s, _t, data) => events.push(`output:${data}`), attachProcess: () => events.push('attach'),
      complete: (_s, _t, status) => events.push(`complete:${status}`), getOutput: async () => ({ output: '', isComplete: true, status: 'completed' }), stop: async () => {},
    }
    const registration: ProcessRegistrationPort = {
      registerPending: input => { expect(input.launcher).toBe('powershell'); return { id: 'task-1' } },
      registerShell: input => { expect(input.pid).toBe(4242); return { id: 'task-1', startTime: 7 } },
    }
    const commands: CommandExecutionPort = {
      execute: async request => {
        requests.push(request)
        request.callbacks?.onSpawn?.(4242)
        request.callbacks?.onStdout?.(Buffer.from('out'))
        request.callbacks?.onStderr?.(Buffer.from('err'))
        return result({ stdout: 'out', stderr: 'err', exitCode: 7 })
      },
      cancel: async () => {}, get: () => undefined,
    }
    const execution = await tool(commands, { backgroundTasks: background, processRegistration: registration }).execute('call-1', { command: 'Get-Location', timeout: 4 }, new AbortController().signal)
    expect(requests[0]).toMatchObject({ command: 'Get-Location', launcher: 'powershell', timeoutMs: 4_000, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
    expect(execution.content[0]?.text).toContain('out\nerr')
    expect(execution.content[0]?.text).toContain('退出码 7')
    expect(events).toEqual(['begin', 'attach', 'output:out', 'output:err', 'complete:failed'])
  })

  test('Given aborted structured execution When the tool returns Then it keeps cancellation text and stopped task state', async () => {
    const statuses: string[] = []
    const commands: CommandExecutionPort = {
      execute: async () => result({ exitCode: null, aborted: true }), cancel: async () => {}, get: () => undefined,
    }
    const execution = await tool(commands, {
      backgroundTasks: { begin() {}, append() {}, attachProcess() {}, complete: (_s, _t, status) => statuses.push(status), getOutput: async () => ({ output: '', isComplete: true, status: 'stopped' }), stop: async () => {} },
      processRegistration: { registerPending: () => ({ id: 'task-2' }), registerShell: () => undefined },
    }).execute('call-2', { command: 'Stop-Process' }, new AbortController().signal)
    expect(execution.content[0]?.text).toContain('已中止')
    expect(statuses).toEqual(['stopped'])
  })

  test('Given a command port rejection When the tool starts Then the task is marked failed before rethrowing', async () => {
    const statuses: string[] = []
    const commands: CommandExecutionPort = { execute: async () => { throw new Error('host down') }, cancel: async () => {}, get: () => undefined }
    await expect(tool(commands, {
      backgroundTasks: { begin() {}, append() {}, attachProcess() {}, complete: (_s, _t, status) => statuses.push(status), getOutput: async () => ({ output: '', isComplete: true, status: 'failed' }), stop: async () => {} },
      processRegistration: { registerPending: () => ({ id: 'task-3' }), registerShell: () => undefined },
    }).execute('call-3', { command: 'Get-Service' }, new AbortController().signal)).rejects.toThrow('host down')
    expect(statuses).toEqual(['failed'])
  })

  test('formats stdout and stderr with the legacy PowerShell status suffix', () => {
    expect(formatPowerShellResult(result({ stdout: 'ok', stderr: 'warn', exitCode: 3 }))).toBe('ok\nwarn\nPowerShell 以退出码 3 结束。')
  })
})
