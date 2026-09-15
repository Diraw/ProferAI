import { describe, expect, test } from 'bun:test'
import {
  COMPACT_EXIT_HYSTERESIS_PX,
  COMPACT_MAX_HEIGHT_RANGE,
  COMPACT_MIN_HEIGHT_RANGE,
  COMPOSER_EDITOR_MIN_HEIGHT,
  COMPOSER_TIER_HEIGHTS,
  DEFAULT_COMPACT_MAX_HEIGHT,
  DEFAULT_COMPACT_MIN_HEIGHT,
  DEFAULT_COMPACT_VIEWPORT_HEIGHT,
  normalizeCompactMaxHeight,
  normalizeCompactMinHeight,
  normalizeCompactViewportHeight,
  resolveCompactViewport,
  resolveComposerMaxHeight,
  resolveComposerMinHeight,
} from './composer-compact-height'

describe('紧凑档阈值归一化', () => {
  test('缺省 / 非法值回退默认 700', () => {
    expect(normalizeCompactViewportHeight(undefined)).toBe(DEFAULT_COMPACT_VIEWPORT_HEIGHT)
    expect(normalizeCompactViewportHeight(null)).toBe(DEFAULT_COMPACT_VIEWPORT_HEIGHT)
    expect(normalizeCompactViewportHeight('abc')).toBe(DEFAULT_COMPACT_VIEWPORT_HEIGHT)
    expect(normalizeCompactViewportHeight(Number.NaN)).toBe(DEFAULT_COMPACT_VIEWPORT_HEIGHT)
    expect(normalizeCompactViewportHeight(-1)).toBe(DEFAULT_COMPACT_VIEWPORT_HEIGHT)
  })

  test('0 是合法值，表示关闭该行为', () => {
    expect(normalizeCompactViewportHeight(0)).toBe(0)
  })

  test('合法值取整并收敛到可配置范围', () => {
    expect(normalizeCompactViewportHeight(820)).toBe(820)
    expect(normalizeCompactViewportHeight(820.6)).toBe(821)
    expect(normalizeCompactViewportHeight('900')).toBe(900)
    expect(normalizeCompactViewportHeight(10)).toBe(400)
    expect(normalizeCompactViewportHeight(99999)).toBe(1600)
  })
})

describe('紧凑档上限归一化', () => {
  test('缺省 / 非法值回退默认 140', () => {
    expect(normalizeCompactMaxHeight(undefined)).toBe(DEFAULT_COMPACT_MAX_HEIGHT)
    expect(normalizeCompactMaxHeight(0)).toBe(DEFAULT_COMPACT_MAX_HEIGHT)
    expect(normalizeCompactMaxHeight('x')).toBe(DEFAULT_COMPACT_MAX_HEIGHT)
  })

  test('收敛到 80–200，避免超过常规默认档', () => {
    expect(normalizeCompactMaxHeight(120)).toBe(120)
    expect(normalizeCompactMaxHeight(10)).toBe(COMPACT_MAX_HEIGHT_RANGE.min)
    expect(normalizeCompactMaxHeight(4000)).toBe(COMPACT_MAX_HEIGHT_RANGE.max)
  })
})

describe('紧凑档最小高度（空内容时的可见高度）', () => {
  test('缺省 / 非法值回退默认 60', () => {
    expect(normalizeCompactMinHeight(undefined)).toBe(DEFAULT_COMPACT_MIN_HEIGHT)
    expect(normalizeCompactMinHeight(0)).toBe(DEFAULT_COMPACT_MIN_HEIGHT)
    expect(normalizeCompactMinHeight('x')).toBe(DEFAULT_COMPACT_MIN_HEIGHT)
  })

  test('收敛到 40–101，不会超过常规最小高度', () => {
    expect(normalizeCompactMinHeight(80)).toBe(80)
    expect(normalizeCompactMinHeight(10)).toBe(COMPACT_MIN_HEIGHT_RANGE.min)
    expect(normalizeCompactMinHeight(999)).toBe(COMPOSER_EDITOR_MIN_HEIGHT)
  })

  test('常规档 101px；紧凑档降到配置值（默认 60px → 变矮约 40px）', () => {
    expect(resolveComposerMinHeight({ compact: false, compactMinHeight: 60 })).toBe(COMPOSER_EDITOR_MIN_HEIGHT)
    expect(resolveComposerMinHeight({ compact: true, compactMinHeight: 60 })).toBe(60)
    expect(COMPOSER_EDITOR_MIN_HEIGHT - 60).toBeGreaterThanOrEqual(39)
    expect(resolveComposerMinHeight({ compact: true, compactMinHeight: Number.NaN })).toBe(DEFAULT_COMPACT_MIN_HEIGHT)
  })
})

describe('迟滞判定（消除拖拽窗口时的反复切换）', () => {
  test('未处于紧凑档：仅低于阈值才进入', () => {
    expect(resolveCompactViewport(false, 699, 700)).toBe(true)
    expect(resolveCompactViewport(false, 700, 700)).toBe(false)
    expect(resolveCompactViewport(false, 900, 700)).toBe(false)
  })

  test('已处于紧凑档：需要高出阈值 + 余量才退出', () => {
    const exitLine = 700 + COMPACT_EXIT_HYSTERESIS_PX
    expect(resolveCompactViewport(true, 720, 700)).toBe(true)
    expect(resolveCompactViewport(true, exitLine - 1, 700)).toBe(true)
    expect(resolveCompactViewport(true, exitLine, 700)).toBe(false)
    expect(resolveCompactViewport(true, 1000, 700)).toBe(false)
  })

  test('阈值附近来回抖动只切换一次，不会反复跳档', () => {
    let compact = false
    const heights = [720, 695, 710, 720, 690, 705, 715, 698]
    const switches: number[] = []
    heights.forEach((height, index) => {
      const next = resolveCompactViewport(compact, height, 700)
      if (next !== compact) switches.push(index)
      compact = next
    })
    expect(switches).toEqual([1])
    expect(compact).toBe(true)
  })

  test('阈值 <= 0 或高度非法时不进入紧凑档', () => {
    expect(resolveCompactViewport(false, 300, 0)).toBe(false)
    expect(resolveCompactViewport(true, 300, 0)).toBe(false)
    expect(resolveCompactViewport(true, Number.NaN, 700)).toBe(true)
  })
})

describe('输入框档位高度解析', () => {
  test('非紧凑档保持既有三档行为', () => {
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: false, compact: false, compactMaxHeight: 140 }))
      .toBe(COMPOSER_TIER_HEIGHTS.default)
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: true, compact: false, compactMaxHeight: 140 }))
      .toBe(COMPOSER_TIER_HEIGHTS.expanded)
  })

  test('手动折叠优先于窗口高度，且与紧凑档无关', () => {
    expect(resolveComposerMaxHeight({ manuallyCollapsed: true, expanded: true, compact: true, compactMaxHeight: 140 }))
      .toBe(COMPOSER_TIER_HEIGHTS.collapsed)
  })

  test('紧凑档：默认档压到配置上限，展开档为该上限 2 倍', () => {
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: false, compact: true, compactMaxHeight: 140 }))
      .toBe(140)
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: true, compact: true, compactMaxHeight: 140 }))
      .toBe(280)
  })

  test('紧凑档上限非法时按默认 140 处理，且不会超过常规档', () => {
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: false, compact: true, compactMaxHeight: Number.NaN }))
      .toBe(DEFAULT_COMPACT_MAX_HEIGHT)
    // 上限顶到 200 时，默认档等于常规默认档，展开档仍不超过 500
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: false, compact: true, compactMaxHeight: 999 }))
      .toBe(COMPOSER_TIER_HEIGHTS.default)
    expect(resolveComposerMaxHeight({ manuallyCollapsed: false, expanded: true, compact: true, compactMaxHeight: 999 }))
      .toBe(400)
  })
})
