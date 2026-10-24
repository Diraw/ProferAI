/**
 * 平滑滚动的诊断采样
 *
 * 引擎每次处理滚轮都会吐一条采样，这里只留最近几条给设置页读数用。
 * 目的是让「为什么我这儿没效果」可观测：设备被判定成像素级输入、容器没命中、
 * 还是接管了但主线程掉帧，三种情况在读数里长得完全不一样。
 */

import type { WheelSample } from './smooth-wheel'

const MAX_SAMPLES = 6

const samples: WheelSample[] = []
const listeners = new Set<() => void>()
let version = 0

export function reportSmoothWheelSample(sample: WheelSample): void {
  samples.push(sample)
  if (samples.length > MAX_SAMPLES) samples.shift()
  version += 1
  for (const listener of listeners) listener()
}

export function readSmoothWheelSamples(): readonly WheelSample[] {
  return samples
}

export function readSmoothWheelVersion(): number {
  return version
}

export function subscribeSmoothWheelSamples(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
