import { expect, test } from 'bun:test'

import {
  resolveWindowsAngleBackend,
  summarizeGpuFeatureStatus,
} from './windows-graphics'

/** 测试用的能力表：允许带 Electron 额外提供的键 */
type FeatureTable = Record<string, string>

/** 一台正常 Windows 机器的典型能力表（含几项常见的 disabled_off 可选能力） */
function healthyStatus(): FeatureTable {
  return {
    '2d_canvas': 'enabled',
    'gpu_compositing': 'enabled',
    'rasterization': 'enabled',
    'webgl': 'enabled',
    'webgl2': 'enabled',
    'video_decode': 'enabled',
    'video_encode': 'enabled',
    'vulkan': 'disabled_off',
    'webgpu': 'disabled_off',
    'skia_graphite': 'disabled_software',
    'raw_draw': 'disabled_software',
  }
}

test('默认不指定 ANGLE 后端，走 Chromium 自己的选择', () => {
  expect(resolveWindowsAngleBackend({})).toBeNull()
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: '' })).toBeNull()
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: '   ' })).toBeNull()
})

test('显式指定合法后端时原样返回', () => {
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: 'd3d11' })).toBe('d3d11')
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: 'D3D9' })).toBe('d3d9')
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: ' d3d11on12 ' })).toBe('d3d11on12')
})

test('swiftshader 与 default 都不是可指定后端', () => {
  // swiftshader 是纯软件光栅化，放开它等于主动关掉 GPU
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: 'swiftshader' })).toBeNull()
  // default 不在白名单内即「不追加 switch」，语义与不设置一致
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: 'default' })).toBeNull()
})

test('未知后端被忽略，不会把非法值传给 Chromium', () => {
  expect(resolveWindowsAngleBackend({ PROFER_ANGLE_BACKEND: 'metal' })).toBeNull()
})

test('硬件路径正常时不判定为降级', () => {
  const diagnostics = summarizeGpuFeatureStatus(healthyStatus())

  expect(diagnostics.compositing).toBe(true)
  expect(diagnostics.rasterization).toBe(true)
  // skia_graphite / raw_draw 是 disabled_software，但不在关键能力里，不能算降级
  expect(diagnostics.degraded).toBe(false)
  expect(diagnostics.softwareFeatures).toEqual([])
  expect(diagnostics.summary).toContain('GPU 硬件路径正常')
})

test('合成掉到软件路径时判定为降级', () => {
  const status = { ...healthyStatus(), gpu_compositing: 'disabled_software' }
  const diagnostics = summarizeGpuFeatureStatus(status)

  expect(diagnostics.compositing).toBe(false)
  expect(diagnostics.degraded).toBe(true)
  expect(diagnostics.softwareFeatures).toContain('gpu_compositing')
  expect(diagnostics.summary).toContain('GPU 已降级到软件路径')
})

test('光栅化掉到软件路径时判定为降级', () => {
  const status = { ...healthyStatus(), rasterization: 'unavailable_software' }
  const diagnostics = summarizeGpuFeatureStatus(status)

  expect(diagnostics.rasterization).toBe(false)
  expect(diagnostics.degraded).toBe(true)
  expect(diagnostics.softwareFeatures).toContain('rasterization')
})

test('能力表缺字段时按未加速处理，不抛异常', () => {
  const diagnostics = summarizeGpuFeatureStatus({})

  expect(diagnostics.compositing).toBe(false)
  expect(diagnostics.degraded).toBe(true)
  expect(diagnostics.summary).toContain('unknown')
})
