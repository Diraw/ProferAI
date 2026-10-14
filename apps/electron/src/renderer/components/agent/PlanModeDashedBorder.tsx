/**
 * PlanModeDashedBorder — 计划模式输入框虚线边框叠加层
 *
 * 用 SVG <rect> 精确控制虚线段长和间距，绝对定位不影响布局。
 * 使用 ResizeObserver 跟踪父容器尺寸。
 *
 * 几何契约：虚线中心线必须与输入框外边框**同心**。
 * 实测半径一律取自计算样式（宿主可能是 rounded-[17px]、经典界面 --radius、
 * 或终端主题的 border-radius: 0），不能再硬编码，否则圆角弧线与宿主错位，
 * 在四个角上表现为「斜切 / 多出一角」的双层轮廓。
 */

import * as React from 'react'

const DASH_LENGTH = 9  // 每段虚线长度
const DASH_GAP = 7     // 虚线间距
const STROKE_WIDTH = 2 // 线宽
const OFFSET = 2       // 虚线中心线向宿主外扩的距离
const FALLBACK_RADIUS = 17 // 宿主计算样式缺失时与输入框 rounded-[17px] 对齐

/** 解析宿主圆角：合法的 0（终端主题直角化）必须保留，只对 NaN 回退。 */
function parseRadius(raw: string): number {
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : FALLBACK_RADIUS
}

interface BorderMetrics {
  /** 宿主 border box 的宽高（与 getBoundingClientRect 同口径） */
  w: number
  h: number
  /** 宿主实际圆角半径 */
  radius: number
  /** 宿主自身边框宽度，用于把绝对定位基准从 padding box 换算到 border box */
  borderWidth: number
}

export function PlanModeDashedBorder(): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = React.useState<BorderMetrics>({
    w: 0,
    h: 0,
    radius: FALLBACK_RADIUS,
    borderWidth: 0,
  })

  React.useEffect(() => {
    const parent = containerRef.current?.parentElement
    if (!parent) return

    // 绝对定位子元素的 inset 基准是父容器的 padding box，而 getBoundingClientRect
    // 量的是 border box；两者相差宿主自身边框宽度，必须一并计入。
    const updateMetrics = () => {
      const rect = parent.getBoundingClientRect()
      const style = window.getComputedStyle(parent)
      setMetrics({
        w: rect.width,
        h: rect.height,
        radius: parseRadius(style.borderTopLeftRadius),
        borderWidth: Number.parseFloat(style.borderTopWidth) || 0,
      })
    }

    updateMetrics()
    const ro = new ResizeObserver(updateMetrics)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  const wrapperInset = -(OFFSET + metrics.borderWidth)
  const svgW = metrics.w + OFFSET * 2
  const svgH = metrics.h + OFFSET * 2
  // SVG rect 已经内缩半个 stroke，虚线中心线只比输入框外边框外扩
  // OFFSET - STROKE_WIDTH / 2；圆角按同样距离外扩，保持同心。
  const dashedRadius = metrics.radius + OFFSET - STROKE_WIDTH / 2

  return (
    <div
      ref={containerRef}
      className="absolute pointer-events-none"
      style={{
        inset: wrapperInset,
        zIndex: 10,
      }}
    >
      {metrics.w > 0 && metrics.h > 0 && (
        <svg
          width={svgW}
          height={svgH}
          className="block"
          style={{ overflow: 'visible' }}
        >
          <rect
            className="plan-mode-stroke"
            x={STROKE_WIDTH / 2}
            y={STROKE_WIDTH / 2}
            width={svgW - STROKE_WIDTH}
            height={svgH - STROKE_WIDTH}
            rx={dashedRadius}
            ry={dashedRadius}
            fill="none"
            stroke="hsl(var(--primary) / 0.45)"
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={`${DASH_LENGTH} ${DASH_GAP}`}
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  )
}
