/**
 * pen-ink — 手写笔墨迹的几何与导出
 *
 * 设计要点：
 * - 只做纯计算与渲染，不碰事件、不碰 React，便于单测
 * - 笔迹用「点列 + 压力」建模，压力缺失时退化到固定宽度（Wacom 轻触可能报 0）
 * - 导出走白底深墨，保证深色主题下图片模型也能看清
 */

export interface InkPoint {
  x: number
  y: number
  /** 0–1；0 表示设备没给压感（Wacom 轻触/悬停常见） */
  pressure: number
}

export interface InkStroke {
  points: InkPoint[]
  /** 笔画基准宽度（CSS px） */
  size: number
}

export interface InkBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 笔尖宽度基准，和 13px 正文视觉重量接近 */
export const INK_BASE_SIZE = 3.2

const PRESSURE_FLOOR = 0.35
const PRESSURE_GAIN = 0.9
/** 压力缺失时的替代值，避免整笔细成一条线 */
const FALLBACK_PRESSURE = 0.45

export function radiusFor(pressure: number, size: number): number {
  const p = pressure > 0 ? Math.min(1, pressure) : FALLBACK_PRESSURE
  return size * (PRESSURE_FLOOR + PRESSURE_GAIN * p)
}

/**
 * Chaikin 细分：把折线修成近似二次 B 样条，两次就足够平滑。
 * 纯函数，返回新数组，不修改入参。
 */
export function smoothPoints(points: InkPoint[], iterations = 2): InkPoint[] {
  let out = points
  for (let it = 0; it < iterations; it++) {
    if (out.length < 3) return out
    const head = out[0]
    const tail = out[out.length - 1]
    if (!head || !tail) return out
    const next: InkPoint[] = [head]
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i]
      const b = out[i + 1]
      if (!a || !b) continue
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
        pressure: a.pressure * 0.75 + b.pressure * 0.25,
      })
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
        pressure: a.pressure * 0.25 + b.pressure * 0.75,
      })
    }
    next.push(tail)
    out = next
  }
  return out
}

/**
 * 把点列转成带锥度和圆头的填充轮廓（perfect-freehand 的简化实现）。
 * 调用方负责 setTransform / fillStyle。
 */
export function buildStrokePath(points: InkPoint[], size: number): Path2D {
  const path = new Path2D()
  if (points.length === 0) return path

  if (points.length === 1) {
    const single = points[0]
    if (!single) return path
    const r = radiusFor(single.pressure, size)
    path.arc(single.x, single.y, r, 0, Math.PI * 2)
    return path
  }

  const smooth = smoothPoints(points)
  const left: Array<{ x: number; y: number }> = []
  const right: Array<{ x: number; y: number }> = []

  for (let i = 0; i < smooth.length; i++) {
    const current = smooth[i]
    if (!current) continue
    const prev = smooth[Math.max(0, i - 1)] ?? current
    const next = smooth[Math.min(smooth.length - 1, i + 1)] ?? current
    let dx = next.x - prev.x
    let dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    const r = radiusFor(current.pressure, size)
    left.push({ x: current.x - dy * r, y: current.y + dx * r })
    right.push({ x: current.x + dy * r, y: current.y - dx * r })
  }

  const first = smooth[0]
  const last = smooth[smooth.length - 1]
  const startLeft = left[0]
  const startRight = right[0]
  const lastLeft = left[left.length - 1]
  const lastRight = right[right.length - 1]
  if (!first || !last || !startLeft || !startRight || !lastLeft || !lastRight) return path

  const rStart = radiusFor(first.pressure, size)
  const rEnd = radiusFor(last.pressure, size)

  path.moveTo(startLeft.x, startLeft.y)
  for (let i = 1; i < left.length; i++) {
    const point = left[i]
    if (point) path.lineTo(point.x, point.y)
  }
  path.arc(
    last.x,
    last.y,
    rEnd,
    Math.atan2(lastLeft.y - last.y, lastLeft.x - last.x),
    Math.atan2(lastRight.y - last.y, lastRight.x - last.x),
    true,
  )
  for (let i = right.length - 1; i >= 0; i--) {
    const point = right[i]
    if (point) path.lineTo(point.x, point.y)
  }
  path.arc(
    first.x,
    first.y,
    rStart,
    Math.atan2(startRight.y - first.y, startRight.x - first.x),
    Math.atan2(startLeft.y - first.y, startLeft.x - first.x),
    true,
  )
  path.closePath()
  return path
}

/** 墨迹外接框；无笔画时返回 null。padding 会外扩，避免裁掉圆头。 */
export function computeInkBounds(strokes: InkStroke[], padding = 0): InkBounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const stroke of strokes) {
    const reach = Math.max(0, radiusFor(1, stroke.size))
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x - reach)
      minY = Math.min(minY, point.y - reach)
      maxX = Math.max(maxX, point.x + reach)
      maxY = Math.max(maxY, point.y + reach)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null

  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  }
}

export interface InkExportOptions {
  /** 输出倍率，默认 2（Retina 下模型看清笔画） */
  scale?: number
  padding?: number
  background?: string
  color?: string
}

/** 把笔迹渲染成白底 PNG 的 canvas；调用方负责 toBlob/insert。 */
export function renderInkCanvas(strokes: InkStroke[], options: InkExportOptions = {}): HTMLCanvasElement | null {
  const { scale = 2, padding = 16, background = '#ffffff', color = '#111827' } = options
  const bounds = computeInkBounds(strokes, padding)
  if (!bounds) return null

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bounds.width * scale))
  canvas.height = Math.max(1, Math.round(bounds.height * scale))

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale)
  ctx.fillStyle = color
  for (const stroke of strokes) {
    ctx.fill(buildStrokePath(stroke.points, stroke.size))
  }
  return canvas
}

/** 导出为 PNG dataURL，供 OCR 通道使用。 */
export function strokesToPngDataUrl(strokes: InkStroke[], options: InkExportOptions = {}): string | null {
  const canvas = renderInkCanvas(strokes, options)
  return canvas ? canvas.toDataURL('image/png') : null
}

/** 导出为可直接进附件通道的 PNG File。 */
export async function strokesToPngFile(strokes: InkStroke[], options: InkExportOptions = {}): Promise<File | null> {
  const canvas = renderInkCanvas(strokes, options)
  if (!canvas) return null

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png')
  })
  if (!blob) return null

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return new File([blob], `handwriting-${stamp}.png`, { type: 'image/png' })
}
