import { describe, expect, test } from 'bun:test'
import { computeInkBounds, radiusFor, smoothPoints, type InkStroke } from './pen-ink'

describe('radiusFor', () => {
  test('满压感给出最大笔宽', () => {
    expect(radiusFor(1, 3.2)).toBeCloseTo(4, 5)
  })

  test('压力缺失时退化到默认值，不断笔', () => {
    // 0.35 + 0.9 * 0.45 = 0.755
    expect(radiusFor(0, 3.2)).toBeCloseTo(2.416, 5)
  })

  test('超过 1 的压力被夹住，避免笔迹爆粗', () => {
    expect(radiusFor(3, 3.2)).toBeCloseTo(4, 5)
  })
})

describe('smoothPoints', () => {
  test('保留首尾点并插入中间点', () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 10, pressure: 0.5 },
      { x: 20, y: 0, pressure: 0.5 },
    ]
    const smoothed = smoothPoints(points, 1)
    expect(smoothed.length).toBeGreaterThan(points.length)
    expect(smoothed[0]).toEqual({ x: 0, y: 0, pressure: 0.5 })
    expect(smoothed[smoothed.length - 1]).toEqual({ x: 20, y: 0, pressure: 0.5 })
  })

  test('点太少时原样返回', () => {
    const points = [{ x: 1, y: 2, pressure: 0 }]
    expect(smoothPoints(points, 2)).toEqual(points)
  })
})

describe('computeInkBounds', () => {
  test('没有笔迹时返回 null', () => {
    expect(computeInkBounds([])).toBeNull()
  })

  test('外接框包住笔尖半径与外扩留白', () => {
    const strokes: InkStroke[] = [
      { size: 3.2, points: [{ x: 10, y: 10, pressure: 1 }] },
    ]
    const bounds = computeInkBounds(strokes, 2)
    expect(bounds).not.toBeNull()
    expect(bounds?.x).toBeCloseTo(4, 5)
    expect(bounds?.y).toBeCloseTo(4, 5)
    expect(bounds?.width).toBeCloseTo(12, 5)
    expect(bounds?.height).toBeCloseTo(12, 5)
  })

  test('多笔合并成一个外接框', () => {
    const strokes: InkStroke[] = [
      { size: 3.2, points: [{ x: 0, y: 0, pressure: 1 }] },
      { size: 3.2, points: [{ x: 100, y: 50, pressure: 1 }] },
    ]
    const bounds = computeInkBounds(strokes, 0)
    expect(bounds?.x).toBeCloseTo(-4, 5)
    expect(bounds?.width).toBeCloseTo(108, 5)
    expect(bounds?.height).toBeCloseTo(58, 5)
  })
})
