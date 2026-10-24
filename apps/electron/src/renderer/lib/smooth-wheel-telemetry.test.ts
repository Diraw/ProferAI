import { describe, expect, test } from 'bun:test'
import {
  readSmoothWheelSamples,
  readSmoothWheelVersion,
  reportSmoothWheelSample,
  subscribeSmoothWheelSamples,
} from './smooth-wheel-telemetry'
import type { WheelSample } from './smooth-wheel'

function sample(deltaY: number, handled: boolean): WheelSample {
  return {
    at: deltaY,
    deltaY,
    deltaMode: 0,
    gapMs: 40,
    gesture: 'tick',
    handled,
    forced: false,
    scroller: handled ? 'div.profer-scroll-region' : null,
    frameMs: 16.7,
    slowFrames: 0,
  }
}

describe('smooth-wheel telemetry', () => {
  test('只保留最近 6 条采样', () => {
    for (let i = 0; i < 10; i += 1) reportSmoothWheelSample(sample(i, true))
    const samples = readSmoothWheelSamples()
    expect(samples.length).toBe(6)
    expect(samples[samples.length - 1]!.deltaY).toBe(9)
  })

  test('订阅者收到通知，退订后不再收到', () => {
    let calls = 0
    const unsubscribe = subscribeSmoothWheelSamples(() => { calls += 1 })
    const before = readSmoothWheelVersion()
    reportSmoothWheelSample(sample(100, true))
    expect(calls).toBe(1)
    expect(readSmoothWheelVersion()).toBe(before + 1)
    unsubscribe()
    reportSmoothWheelSample(sample(101, true))
    expect(calls).toBe(1)
  })
})
