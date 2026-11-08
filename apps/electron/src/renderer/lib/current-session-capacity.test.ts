import { describe, expect, test } from 'bun:test'
import {
  buildCurrentSessionMaxHeight,
  CURRENT_SESSION_MIN_MAX_HEIGHT_PX,
  CURRENT_SESSION_RESERVED_VIEWPORT_PX,
  CURRENT_SESSION_ROW_HEIGHT_PX,
  CURRENT_SESSION_VISIBLE_COUNT_OPTIONS,
  DEFAULT_CURRENT_SESSION_VISIBLE_COUNT,
  normalizeCurrentSessionVisibleCount,
  resolveEffectiveVisibleRows,
} from './current-session-capacity'

describe('normalizeCurrentSessionVisibleCount — 只放行白名单档位', () => {
  test('Given 缺省或非法值 When 归一化 Then 回落到默认 12', () => {
    expect(DEFAULT_CURRENT_SESSION_VISIBLE_COUNT).toBe(12)
    for (const value of [undefined, null, '12', 12.5, 0, -1, 7, 100, Number.NaN]) {
      expect(normalizeCurrentSessionVisibleCount(value)).toBe(12)
    }
  })

  test('Given 合法档位 When 归一化 Then 原样保留', () => {
    for (const value of CURRENT_SESSION_VISIBLE_COUNT_OPTIONS) {
      expect(normalizeCurrentSessionVisibleCount(value)).toBe(value)
    }
  })
})

describe('buildCurrentSessionMaxHeight — N 是上限而非目标高度', () => {
  test('Given 档位 12 When 生成表达式 Then 同时被 N 行、视口剩余空间与硬下限夹住', () => {
    const css = buildCurrentSessionMaxHeight(12)
    expect(css.startsWith('min(')).toBe(true)
    expect(css).toContain(`calc(12 * ${CURRENT_SESSION_ROW_HEIGHT_PX}px)`)
    expect(css).toContain(`calc(100vh - ${CURRENT_SESSION_RESERVED_VIEWPORT_PX}px)`)
    expect(css).toContain(`${CURRENT_SESSION_MIN_MAX_HEIGHT_PX}px`)
  })

  test('Given 非法档位 When 生成表达式 Then 按默认档位生成且不产生 NaN', () => {
    const css = buildCurrentSessionMaxHeight(9999)
    expect(css).toBe(buildCurrentSessionMaxHeight(DEFAULT_CURRENT_SESSION_VISIBLE_COUNT))
    expect(css).not.toContain('NaN')
  })

  test('Given 档位切换 When 生成表达式 Then 行数上限随档位变化', () => {
    for (const count of CURRENT_SESSION_VISIBLE_COUNT_OPTIONS) {
      expect(buildCurrentSessionMaxHeight(count)).toContain(`calc(${count} * ${CURRENT_SESSION_ROW_HEIGHT_PX}px)`)
    }
  })
})

describe('resolveEffectiveVisibleRows — 设置页提示与侧栏夹算同源', () => {
  test('Given 高窗口 When 计算 Then 实际可见行数等于档位', () => {
    expect(resolveEffectiveVisibleRows(5, 1200)).toBe(5)
    expect(resolveEffectiveVisibleRows(12, 1200)).toBe(12)
  })

  test('Given 矮窗口 When 计算 Then 可见行数被夹住且至少 1 行', () => {
    expect(resolveEffectiveVisibleRows(20, 600)).toBeLessThan(20)
    expect(resolveEffectiveVisibleRows(20, 200)).toBeGreaterThanOrEqual(1)
  })

  test('Given 非有限窗口高度 When 计算 Then 不产生 NaN', () => {
    expect(Number.isFinite(resolveEffectiveVisibleRows(12, Number.NaN))).toBe(true)
  })
})
