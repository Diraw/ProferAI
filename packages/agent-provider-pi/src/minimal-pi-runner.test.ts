/**
 * 把最小 runner 的场景接入 `bun test`。
 *
 * runner 会在本进程内把真实 Pi SDK 的 ModelRuntime.streamSimple 换成脚本传输，
 * 因此该文件必须独立运行（仓库统一使用 `bun test --isolate`）。
 */

import { describe, expect, test } from 'bun:test'
import { runAllScenarios } from '../test/minimal-pi-runner'

describe('最小 Pi provider runner（真实 SDK + 脚本化传输 + 非 Electron 宿主）', () => {
  test('消息流、工具、取消、错误、终态与资源释放全部通过', async () => {
    const results = await runAllScenarios()
    const failed = results.filter((item) => !item.passed)
    expect(results.length).toBeGreaterThan(0)
    expect(failed.map((item) => `${item.name}: ${item.detail}`)).toEqual([])
  }, 120_000)
})
