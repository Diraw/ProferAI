import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createSessionStorePaths } from './paths'
import { copyGraphEventsThroughTimestamp, copyHarnessEventsThroughTimestamp } from './event-store'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('session event store', () => {
  test('copies graph and harness events only through the fork boundary', async () => {
    root = await mkdtemp(`${tmpdir()}/profer-event-store-`)
    const paths = createSessionStorePaths(root)
    await mkdir(paths.sessionsDir, { recursive: true })
    await writeFile(`${paths.sessionsDir}/source-graph.jsonl`, [
      JSON.stringify({ type: 'task_created', timestamp: 10, taskId: 't1', payload: { subject: 'one', description: '', dependsOn: [] } }),
      JSON.stringify({ type: 'task_updated', timestamp: 20, taskId: 't1', payload: { subject: 'two' } }),
    ].join('\n') + '\n')
    await writeFile(`${paths.sessionsDir}/source-pi-harness.jsonl`, [
      JSON.stringify({ timestamp: 10, value: 'keep' }),
      JSON.stringify({ timestamp: 20, value: 'drop' }),
      'bad-json',
    ].join('\n') + '\n')

    expect(await copyGraphEventsThroughTimestamp(paths, 'source', 'fork', 10)).toBe(1)
    expect(await copyHarnessEventsThroughTimestamp(paths, 'source', 'fork', 10)).toBe(1)
    expect((await readFile(`${paths.sessionsDir}/fork-graph.jsonl`, 'utf8')).match(/timestamp/g)).toHaveLength(1)
    expect(await readFile(`${paths.sessionsDir}/fork-pi-harness.jsonl`, 'utf8')).toContain('keep')
    expect(await readFile(`${paths.sessionsDir}/fork-pi-harness.jsonl`, 'utf8')).not.toContain('drop')
  })
})
