/**
 * Windows 图形路径配置与诊断
 *
 * 集中两件与「Windows 上帧率明显低于 macOS」直接相关的事：
 * 1. ANGLE 后端的显式覆盖（Chromium 进程级开关，默认不动）
 * 2. GPU 合成/光栅状态的日志摘要
 *
 * 背景：GPU 进程崩溃后 Chromium 会静默降级到软件合成且不自动恢复，
 * 表现就是动画与流式输出掉到个位数帧率。没有这条日志时，这种降级
 * 会被误判成「渲染代码慢」，从而在错误的层面做优化。
 */

/**
 * 允许通过 PROFER_ANGLE_BACKEND 显式指定的后端。
 *
 * 刻意不含 swiftshader：那是纯软件光栅化，设置它等于主动关掉 GPU，
 * 只会让帧率更差，不具备「兼容性逃生舱」的意义。
 */
export const WINDOWS_ANGLE_BACKENDS = ['d3d11', 'd3d9', 'd3d11on12', 'gl'] as const

export type WindowsAngleBackend = (typeof WINDOWS_ANGLE_BACKENDS)[number]

/**
 * 解析显式指定的 ANGLE 后端。
 *
 * 返回 null 表示不追加任何 switch，走 Chromium 自己的默认后端选择——
 * 这是绝大多数 Windows 机器上最快的路径。
 */
export function resolveWindowsAngleBackend(
  env: NodeJS.ProcessEnv = process.env,
): WindowsAngleBackend | null {
  const raw = env.PROFER_ANGLE_BACKEND?.trim().toLowerCase()
  if (!raw) return null
  return (WINDOWS_ANGLE_BACKENDS as readonly string[]).includes(raw)
    ? (raw as WindowsAngleBackend)
    : null
}

/**
 * 我们关心的 GPU 能力。
 *
 * 用具体键而不是 `Record<string, string>`：Electron 的 GPUFeatureStatus 是一组固定键的
 * interface，没有索引签名，直接声明成 Record 会无法传入（它本身就是这个结构的超集）。
 */
export interface GpuFeatureStatus {
  '2d_canvas'?: string
  gpu_compositing?: string
  rasterization?: string
  video_decode?: string
  webgl?: string
}

/**
 * 参与降级判定的关键能力。
 *
 * 只取这几项，是因为 webgpu / vulkan / skia_graphite 等可选能力在正常机器上
 * 也常是 disabled_off 或 disabled_software，把它们算进降级会造成误报。
 */
const KEY_FEATURES = ['gpu_compositing', 'rasterization', '2d_canvas', 'webgl', 'video_decode'] as const

export interface GpuDiagnostics {
  /** 合成是否走在硬件路径上 */
  compositing: boolean
  /** 光栅化是否走在硬件路径上 */
  rasterization: boolean
  /** 是否已降级到软件路径 */
  degraded: boolean
  /** 关键能力里处于软件路径的项 */
  softwareFeatures: string[]
  /** 一行摘要，直接写日志用 */
  summary: string
}

function isHardware(status: string | undefined): boolean {
  return typeof status === 'string' && status.startsWith('enabled')
}

/** disabled_software / unavailable_software 表示「该能力走软件实现」 */
function isSoftwareFallback(status: string | undefined): boolean {
  return typeof status === 'string' && status.endsWith('_software')
}

/**
 * 把 GPU 能力表压缩成可判读的结论。
 *
 * 判定标准只看 gpu_compositing 与 rasterization：这两项任意一项不在硬件路径上，
 * 流式输出与动画就已经没有帧预算可言了，后续优化渲染代码都是白费。
 */
export function summarizeGpuFeatureStatus(status: GpuFeatureStatus): GpuDiagnostics {
  const compositing = isHardware(status.gpu_compositing)
  const rasterization = isHardware(status.rasterization)
  const softwareFeatures = KEY_FEATURES.filter((name) => isSoftwareFallback(status[name]))
  const degraded = !compositing || !rasterization

  const summary = degraded
    ? `GPU 已降级到软件路径：compositing=${status.gpu_compositing ?? 'unknown'}`
      + ` rasterization=${status.rasterization ?? 'unknown'}`
      + ` 软件能力=${softwareFeatures.join(',') || '无'}`
    : `GPU 硬件路径正常：compositing=${status.gpu_compositing} rasterization=${status.rasterization}`

  return { compositing, rasterization, degraded, softwareFeatures, summary }
}
