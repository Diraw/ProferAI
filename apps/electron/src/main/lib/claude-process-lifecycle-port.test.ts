import { describe, expect, mock, test } from 'bun:test'
import { BackgroundTaskManager } from './background-task-manager'
import { createElectronClaudeProcessLifecyclePort } from './claude-process-lifecycle-port'

describe('Electron Claude task authority', () => {
  test('Given foreign or mismatched tasks When stopping Then validation prevents provider calls', async () => {
    const manager = new BackgroundTaskManager()
    const port = createElectronClaudeProcessLifecyclePort(manager)
    port.onTaskEvent!('owner', { taskId: 'task', type: 'shell', status: 'running' })
    const stop = mock(async () => {})
    await expect(port.stopTask!('foreign', 'task', 'shell', stop)).rejects.toThrow('不属于当前会话')
    await expect(port.stopTask!('owner', 'task', 'agent', stop)).rejects.toThrow('类型不匹配')
    expect(stop).not.toHaveBeenCalled()
    expect(manager.get('owner', 'task')?.status).toBe('running')
  })

  test('Given a running task When SDK stop fails or is missing Then authority never claims stopped', async () => {
    const manager = new BackgroundTaskManager()
    const port = createElectronClaudeProcessLifecyclePort(manager)
    port.onTaskEvent!('owner', { taskId: 'task', status: 'running' })
    await expect(port.stopTask!('owner', 'task')).rejects.toThrow('not configured')
    await expect(port.stopTask!('owner', 'task', undefined, async () => { throw new Error('SDK failed') })).rejects.toThrow('SDK failed')
    expect(manager.get('owner', 'task')?.status).toBe('running')
  })

  test('Given an owned task When stopped twice Then SDK stop executes once and output reflects stopped', async () => {
    const manager = new BackgroundTaskManager()
    const port = createElectronClaudeProcessLifecyclePort(manager)
    port.onTaskEvent!('owner', { taskId: 'task', type: 'agent', status: 'running', summary: 'working' })
    const stop = mock(async () => { expect(manager.get('owner', 'task')?.status).toBe('running') })
    await port.stopTask!('owner', 'task', 'agent', stop)
    await port.stopTask!('owner', 'task', 'agent', stop)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await port.getTaskOutput!('owner', 'task')).toEqual({ output: '', isComplete: true, status: 'stopped', summary: 'working' })
    port.onExit!('owner')
    await expect(port.getTaskOutput!('owner', 'task')).rejects.toThrow('不属于当前会话')
  })

  test('Given task notification during stop When SDK settles Then completed state is preserved', async () => {
    const port = createElectronClaudeProcessLifecyclePort()
    port.onTaskEvent!('owner', { taskId: 'task', status: 'running' })
    await port.stopTask!('owner', 'task', undefined, async () => {
      port.onTaskEvent!('owner', { taskId: 'task', status: 'completed', summary: 'completed during stop' })
    })
    expect(await port.getTaskOutput!('owner', 'task')).toMatchObject({ status: 'completed', isComplete: true })
  })
})
