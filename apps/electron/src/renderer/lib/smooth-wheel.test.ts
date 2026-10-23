import { describe, expect, test } from 'bun:test'
import {
  SPRING_STIFFNESS,
  classifyWheel,
  normalizeWheelDelta,
  stepSpring,
  wheelBoost,
} from './smooth-wheel'

describe('classifyWheel', () => {
  test('Windows 鼠标刻度：100 / 120 像素都算离散刻度', () => {
    expect(classifyWheel(0, 100)).toBe('tick')
    expect(classifyWheel(0, 120)).toBe('tick')
    expect(classifyWheel(0, -300)).toBe('tick')
    // 不同 DPI / 系统设置下刻度换算可能落在别的值，只要够大一格就按刻度处理
    expect(classifyWheel(0, 96)).toBe('tick')
  })

  test('行模式与页模式本身就是离散语义', () => {
    expect(classifyWheel(1, 3)).toBe('tick')
    expect(classifyWheel(2, 1)).toBe('tick')
  })

  test('触控板与高精度滚轮的像素级 delta 直通原生', () => {
    expect(classifyWheel(0, 33)).toBe('pixel')
    expect(classifyWheel(0, 100.5)).toBe('pixel')
    expect(classifyWheel(0, 4)).toBe('pixel')
    // 不足一格的零头（部分驱动会拆成一格的分数）
    expect(classifyWheel(0, 60)).toBe('pixel')
  })
})

describe('wheelBoost', () => {
  test('单格慢转不加速', () => {
    expect(wheelBoost(400)).toBe(1)
    expect(wheelBoost(130)).toBe(1)
  })

  test('连滚加速并在上限封顶', () => {
    expect(wheelBoost(30)).toBeCloseTo(1.9, 5)
    expect(wheelBoost(5)).toBeCloseTo(1.9, 5)
    expect(wheelBoost(80)).toBeGreaterThan(1.4)
    expect(wheelBoost(80)).toBeLessThan(1.5)
  })

  test('间隔越小倍数越大（单调）', () => {
    const gaps = [130, 110, 90, 70, 50, 30]
    const boosts = gaps.map(wheelBoost)
    for (let i = 1; i < boosts.length; i += 1) {
      expect(boosts[i]!).toBeGreaterThan(boosts[i - 1]!)
    }
  })
})

describe('normalizeWheelDelta', () => {
  test('像素模式原样返回', () => {
    expect(normalizeWheelDelta(0, 100, 800)).toBe(100)
  })

  test('行模式按行高折算', () => {
    expect(normalizeWheelDelta(1, 3, 800)).toBe(120)
  })

  test('页模式按视口高度折算', () => {
    expect(normalizeWheelDelta(2, 1, 800)).toBe(800)
  })
})

describe('stepSpring', () => {
  /** 以 60fps 推进弹簧，返回落定时间（ms）、最大过冲与最终位置。 */
  function run(target: number, frames = 60) {
    const state = { position: 0, velocity: 0 }
    let maxPosition = 0
    let settledAt: number | null = null
    for (let i = 1; i <= frames; i += 1) {
      for (let s = 0; s < 4; s += 1) stepSpring(state, target, 16 / 4 / 1000)
      maxPosition = Math.max(maxPosition, state.position)
      if (settledAt === null && Math.abs(target - state.position) < 0.8 && Math.abs(state.velocity) < 40) {
        settledAt = i * 16
      }
    }
    return { state, maxPosition, settledAt }
  }

  test('一格 100px 在 200–360ms 内落定', () => {
    const { settledAt, state } = run(100)
    expect(settledAt).not.toBeNull()
    expect(settledAt!).toBeGreaterThan(200)
    expect(settledAt!).toBeLessThan(360)
    expect(state.position).toBeCloseTo(100, 1)
  })

  test('临界阻尼不过冲', () => {
    const { maxPosition } = run(100)
    expect(maxPosition).toBeLessThanOrEqual(100.5)
  })

  test('刚度与落地时间一致（k=620 约 300ms）', () => {
    expect(SPRING_STIFFNESS).toBe(620)
    const { settledAt } = run(100, 80)
    expect(settledAt!).toBeLessThan(330)
  })

  test('长距离滚动不会因为帧率抖动发散', () => {
    const state = { position: 0, velocity: 0 }
    for (let i = 0; i < 200; i += 1) stepSpring(state, 3000, 0.034 / 4)
    expect(Number.isFinite(state.position)).toBe(true)
    expect(state.position).toBeGreaterThan(2900)
    expect(state.position).toBeLessThan(3100)
  })
})
