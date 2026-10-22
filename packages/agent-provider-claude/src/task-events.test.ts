import { describe, expect, test } from 'bun:test'
import { normalizeClaudeTaskEvent } from './task-events'

describe('Claude SDK task event normalization（provider 侧）', () => {
  test('Given task aliases When started/progress/notification arrive Then provider keeps type, status and output evidence', () => {
    for (const task_type of ['shell', 'bash', 'local_bash']) {
      expect(normalizeClaudeTaskEvent({ type: 'system', subtype: 'task_started', task_id: 't', task_type })).toEqual({ taskId: 't', type: 'shell', status: 'running' })
    }
    for (const task_type of ['agent', 'subagent', 'task']) {
      expect(normalizeClaudeTaskEvent({ type: 'system', subtype: 'task_progress', task_id: 't', task_type, summary: 'working' })).toEqual({ taskId: 't', type: 'agent', status: 'running', summary: 'working' })
    }
    for (const status of ['failed', 'stopped', 'completed'] as const) {
      expect(normalizeClaudeTaskEvent({ type: 'system', subtype: 'task_notification', task_id: 't', status, output_file: '/sdk/output', summary: 'done' })).toEqual({ taskId: 't', status, outputFile: '/sdk/output', summary: 'done' })
    }
  })

  test('Given unrelated or malformed SDK messages When normalized Then no task record is fabricated', () => {
    for (const message of [
      { type: 'assistant', subtype: 'task_started', task_id: 't' },
      { type: 'system', subtype: 'init', task_id: 't' },
      { type: 'system', subtype: 'task_started', task_id: '' },
      { type: 'system', subtype: 'task_started', task_id: 42 },
    ]) expect(normalizeClaudeTaskEvent(message)).toBeUndefined()
    expect(normalizeClaudeTaskEvent({ type: 'system', subtype: 'task_notification', task_id: 't', task_type: 'unknown', summary: 1, output_file: false, status: 'success' })).toEqual({ taskId: 't', status: 'completed', summary: undefined, outputFile: undefined })
  })
})
