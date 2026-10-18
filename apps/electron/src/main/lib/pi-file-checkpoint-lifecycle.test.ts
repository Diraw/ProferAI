/**
 * pi-file-checkpoint-lifecycle 单测（GAP-2）
 *
 * 证据口径：
 * - 用**真实** `createPiFileCheckpoint` / `prunePiFileCheckpoints` 与真实临时目录，
 *   而不是把规则再写一遍；
 * - 「失败不阻断」既用注入抛错验证语义，也用**真实失败**（rootDir 是文件而非目录）验证；
 * - 「新路径产物可被回退消费」直接按 `rewindPiSession` 的取法
 *   （`meta.piFileCheckpoints[entryId]` → `loadPiFileCheckpoint` → `restorePiFileCheckpoint`）
 *   真实恢复工作区文件。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeSessionPersister } from './agent-runtime-native-session-persistence'
import {
  beginPiCheckpointTurn,
  type PiCheckpointLifecycleLogger,
} from './pi-file-checkpoint-lifecycle'
import { createPiFileCheckpoint, loadPiFileCheckpoint, restorePiFileCheckpoint } from './pi-file-checkpoint'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop()!
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), 'pi-ckpt-lifecycle-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  const checkpointRoot = join(base, 'checkpoints')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(checkpointRoot, { recursive: true })
  return { base, workspace, checkpointRoot }
}

/** 静默 logger：失败路径会产生 warn，测试自己决定是否断言。 */
function silentLogger(warnings: string[] = [], errors: string[] = []): PiCheckpointLifecycleLogger {
  return {
    warn: (message, error) => {
      warnings.push(message)
      if (error !== undefined) errors.push(error instanceof Error ? error.message : String(error))
    },
    log: () => {},
  }
}

describe('创建：真实快照 + 失败不阻断', () => {
  test('真实创建成功：返回路径存在，绑定补丁把 entry 指向本轮检查点', () => {
    const { workspace, checkpointRoot } = makeDirs()
    writeFileSync(join(workspace, 'a.txt'), 'v1')

    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      logger: silentLogger(),
    })

    expect(turn.created).toBe(true)
    expect(turn.path).toBeTruthy()
    expect(existsSync(turn.path!)).toBe(true)

    const patch = turn.resolveCheckpointPatch({ bindings: { 'uuid-1': 'entry-1' }, meta: undefined })
    expect(patch).toEqual({ piFileCheckpoints: { 'entry-1': turn.path! } })
  })

  test('真实创建失败（rootDir 是文件）不抛错、不阻断，且不触碰 piFileCheckpoints', () => {
    const { base, workspace } = makeDirs()
    const notADir = join(base, 'not-a-dir')
    writeFileSync(notADir, 'x')
    const warnings: string[] = []

    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: notADir,
      collectForeignPaths: () => [],
      logger: silentLogger(warnings),
    })

    expect(turn.created).toBe(false)
    expect(turn.path).toBeUndefined()
    expect(warnings.some((line) => line.includes('检查点创建失败'))).toBe(true)
    // 与旧链 `...(piTurnCheckpoint ? { piFileCheckpoints } : {})` 一致：失败时完全不写该字段。
    expect(turn.resolveCheckpointPatch({ bindings: { 'uuid-1': 'entry-1' }, meta: undefined })).toBeUndefined()
  })

  test('注入的创建实现抛错时同样降级（语义 1：失败不得阻断本轮运行）', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const warnings: string[] = []
    const errors: string[] = []
    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      collectForeignPaths: () => [],
      createCheckpoint: () => { throw new Error('EBUSY: 浏览器 Cookies 被独占锁定') },
      logger: silentLogger(warnings, errors),
    })

    expect(turn.created).toBe(false)
    expect(warnings[0]).toContain('本轮继续但不可文件回退')
    expect(errors[0]).toContain('EBUSY')
  })
})

describe('绑定与回收：keep 规则对齐旧链', () => {
  test('绑定当前轮、回收无人引用的旧条目、保留跨会话仍在引用的条目', () => {
    const { workspace, checkpointRoot } = makeDirs()
    writeFileSync(join(workspace, 'a.txt'), 'v1')
    const deps = {
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' as const },
      logger: silentLogger(),
    }

    // 第一轮：绑定 entry-1
    const turn1 = beginPiCheckpointTurn({ ...deps, collectForeignPaths: () => [] })
    const meta1 = turn1.resolveCheckpointPatch({ bindings: { 'uuid-1': 'entry-1' }, meta: undefined })!
    const path1 = (meta1.piFileCheckpoints as Record<string, string>)['entry-1']!

    // 一个无人引用的孤儿检查点（模拟某轮绑定失败 / 被截断的 turn）
    const orphan = createPiFileCheckpoint('session-1', workspace, checkpointRoot, { mode: 'copy' }).path
    expect(existsSync(orphan)).toBe(true)

    // 第二轮：绑定 entry-2，并声明 entry-1 的检查点被其它会话引用
    const turn2 = beginPiCheckpointTurn({ ...deps, collectForeignPaths: () => [path1] })
    const patch2 = turn2.resolveCheckpointPatch({
      bindings: { 'uuid-2': 'entry-2' },
      meta: { id: 'session-1', title: 't', createdAt: 1, updatedAt: 1, piFileCheckpoints: { 'entry-1': path1 } },
    })!

    const checkpoints = patch2.piFileCheckpoints as Record<string, string>
    expect(checkpoints['entry-1']).toBe(path1)
    expect(checkpoints['entry-2']).toBe(turn2.path)
    expect(existsSync(path1)).toBe(true)
    expect(existsSync(turn2.path!)).toBe(true)
    // 无人引用且未声明的孤儿被真实回收
    expect(existsSync(orphan)).toBe(false)
  })

  test('本轮 bindings 为空时仍执行一次回收（旧链语义），且本轮快照不被自己回收', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const pruneCalls: Array<{ keepPaths: string[] }> = []
    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      pruneCheckpoints: (_rootDir, _sessionId, options = {}) => {
        pruneCalls.push({ keepPaths: [...(options.keepPaths ?? [])] })
        return { removed: [], removedBound: 0, releasedRepo: false }
      },
      logger: silentLogger(),
    })

    const patch = turn.resolveCheckpointPatch({ bindings: {}, meta: undefined })
    expect(pruneCalls).toHaveLength(1)
    expect(pruneCalls[0]!.keepPaths).toContain(turn.path!)
    expect(patch).toEqual({ piFileCheckpoints: {} })
  })

  test('回收失败不阻断：保留既有映射并返回（不抛错）', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const warnings: string[] = []
    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      pruneCheckpoints: () => { throw new Error('readdirSync EACCES') },
      logger: silentLogger(warnings),
    })

    const patch = turn.resolveCheckpointPatch({
      bindings: { 'uuid-2': 'entry-2' },
      meta: { id: 'session-1', title: 't', createdAt: 1, updatedAt: 1, piFileCheckpoints: { 'entry-1': '/old' } },
    })
    expect(patch).toEqual({ piFileCheckpoints: { 'entry-1': '/old', 'entry-2': turn.path! } })
    expect(warnings.some((line) => line.includes('回收 Pi 文件检查点失败'))).toBe(true)
  })

  test('被回收的路径会从映射里摘掉（回退点明确降级，不静默失效）', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      pruneCheckpoints: () => ({ removed: ['/gone/1'], removedBound: 1, releasedRepo: false }),
      logger: silentLogger(),
    })

    const patch = turn.resolveCheckpointPatch({
      bindings: { 'uuid-2': 'entry-2' },
      meta: { id: 'session-1', title: 't', createdAt: 1, updatedAt: 1, piFileCheckpoints: { 'entry-1': '/gone/1' } },
    })
    const checkpoints = patch!.piFileCheckpoints as Record<string, string>
    expect(checkpoints['entry-1']).toBeUndefined()
    expect(checkpoints['entry-2']).toBe(turn.path)
  })
})

describe('与 native session persister 的接线', () => {
  test('注入 checkpointLifecycle 后：绑定写入 piFileCheckpoints（本轮真实快照路径）', () => {
    const { workspace, checkpointRoot } = makeDirs()
    writeFileSync(join(workspace, 'a.txt'), 'v1')
    const turn = beginPiCheckpointTurn({
      sessionId: 's',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      logger: silentLogger(),
    })

    const patches: Array<Partial<Record<string, unknown>>> = []
    const persister = createNativeSessionPersister({
      sessions: {
        getMeta: () => ({ id: 's', title: 't', createdAt: 1, updatedAt: 1, piEntryBindings: { 'uuid-0': 'entry-0' } }),
        updateMeta: (_id, patch) => { patches.push(patch as Partial<Record<string, unknown>>); return undefined },
      },
      sessionId: 's',
      checkpointLifecycle: turn,
    })

    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    expect(patches.at(-1)).toEqual({
      piEntryBindings: { 'uuid-0': 'entry-0', 'uuid-1': 'entry-1' },
      piFileCheckpoints: { 'entry-1': turn.path },
    })
  })

  test('创建失败的生命周期注入后：只合并 bindings，不写 piFileCheckpoints（也不阻断）', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const turn = beginPiCheckpointTurn({
      sessionId: 's',
      cwd: workspace,
      rootDir: checkpointRoot,
      collectForeignPaths: () => [],
      createCheckpoint: () => { throw new Error('disk full') },
      logger: silentLogger(),
    })
    expect(turn.created).toBe(false)

    const patches: Array<Partial<Record<string, unknown>>> = []
    const persister = createNativeSessionPersister({
      sessions: {
        getMeta: () => undefined,
        updateMeta: (_id, patch) => { patches.push(patch as Partial<Record<string, unknown>>); return undefined },
      },
      sessionId: 's',
      checkpointLifecycle: turn,
    })

    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    expect(patches).toEqual([{ piEntryBindings: { 'uuid-1': 'entry-1' } }])
  })
})

describe('新路径产物能被 rewind 侧消费（GAP-2 缺口 4 的离线取证）', () => {
  test('按 rewindPiSession 的取法恢复文件：meta.piFileCheckpoints[entryId] → load → restore', () => {
    const { workspace, checkpointRoot } = makeDirs()
    const filePath = join(workspace, 'note.txt')
    writeFileSync(filePath, '本轮改动前的基线')

    const turn = beginPiCheckpointTurn({
      sessionId: 'session-1',
      cwd: workspace,
      rootDir: checkpointRoot,
      checkpointOptions: { mode: 'copy' },
      collectForeignPaths: () => [],
      logger: silentLogger(),
    })
    const patch = turn.resolveCheckpointPatch({ bindings: { 'uuid-1': 'entry-1' }, meta: undefined })!
    // 宿主把补丁写进会话元数据（新路径由 SessionPort.updateMeta 落盘）
    const meta = { id: 'session-1', title: 't', createdAt: 1, updatedAt: 1, ...patch }

    // 本轮模型改动了工作区
    writeFileSync(filePath, '本轮改动后')
    writeFileSync(join(workspace, 'new-file.txt'), '本轮新增')

    // rewindPiSession 的取法（agent-session-manager.ts）：
    //   const checkpointPath = sessionMeta.piFileCheckpoints?.[entryId]
    const entryId = 'entry-1'
    const checkpointPath = (meta.piFileCheckpoints as Record<string, string>)[entryId]
    expect(checkpointPath).toBeTruthy()

    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath!), workspace)
    expect(restored.failed).toBeUndefined()
    expect(readFileSync(filePath, 'utf8')).toBe('本轮改动前的基线')
    // 本轮新增的文件被删除（回退到基线）
    expect(existsSync(join(workspace, 'new-file.txt'))).toBe(false)
    expect(restored.changed).toContain('note.txt')
  })
})
