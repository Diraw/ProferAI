/**
 * parity 门禁自检 —— 防止「新旧执行链对照用例」再次被测试发现机制漏掉。
 *
 * 背景：`runtime-migration-parity/` 下的 8 个对照文件最初命名为 `*.parity.ts`，
 * 不匹配 bun test 的发现规则（`.test` / `_test_` / `.spec` / `_spec_`），
 * 因此 `bun test --isolate` 与两个 CI workflow 都不会执行它们 —— 132 条用例
 * 在门禁上等于不存在，而它们恰恰是「切换默认执行链」的前置证据。
 *
 * 本测试只做一件事：断言该目录下的**每个**源文件要么是测试文件、要么是 support 设施。
 * 任何人把 `.parity.test.ts` 改回 `.parity.ts`（或新增一个不被发现的对照文件），
 * 这里会立刻失败并说明原因。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PARITY_DIR = import.meta.dir
/** 本文件自身：它也在被检目录里，需要显式豁免。 */
const SELF = 'parity-gate.test.ts'
/** 设施子目录：切片编译、旧引擎桩、宿主桩等，不是测试。 */
const SUPPORT_DIR = 'support'

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => {
    if (name.startsWith('.')) return false
    const full = join(dir, name)
    return statSync(full).isFile() && /\.tsx?$/.test(name)
  })
}

describe('parity 对照用例必须被默认测试发现', () => {
  const files = listTsFiles(PARITY_DIR)
  const parityTests = files.filter((name) => name.endsWith('.parity.test.ts'))

  test('目录结构符合约定：只有 *.parity.test.ts 与 support/ 设施', () => {
    const offenders = files.filter((name) => {
      if (name === SELF) return false
      return !name.endsWith('.parity.test.ts')
    })
    expect(
      offenders,
      `以下文件不会被 bun test 发现，请改名为 *.parity.test.ts：${offenders.join(', ')}`,
    ).toEqual([])
  })

  test('八个对照域全部在位（入口 / 生命周期 / 所有权 / 投影 / 能力 / 恢复 / 持久化 / 路由）', () => {
    expect(parityTests.sort()).toEqual([
      'capability-snapshot.parity.test.ts',
      'desktop-entry.parity.test.ts',
      'entry-routing.parity.test.ts',
      'lifecycle.parity.test.ts',
      'ownership.parity.test.ts',
      'persistence-events.parity.test.ts',
      'projection-lifecycle.parity.test.ts',
      'resume-callbacks.parity.test.ts',
    ])
  })

  test('support/ 设施不是测试文件（避免被误当用例重复执行）', () => {
    const supportDir = join(PARITY_DIR, SUPPORT_DIR)
    const supportFiles = listTsFiles(supportDir)
    expect(supportFiles.length).toBeGreaterThan(0)
    const mistaken = supportFiles.filter((name) => /\.(?:test|spec)\.[jt]sx?$/.test(name))
    expect(mistaken, `support/ 下不应放测试：${mistaken.join(', ')}`).toEqual([])
  })
})
