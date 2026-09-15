import * as React from 'react'

/**
 * 订阅窗口内高（window.innerHeight）。
 *
 * 用于窗口高度驱动的布局档位（如输入框紧凑档）和设置页的实时状态提示。
 * - resize 回调走 rAF 节流，一帧最多判定一次；
 * - 高度未变化时返回原值，React 会跳过重渲染。
 */
export function useWindowInnerHeight(): number {
  const [height, setHeight] = React.useState(() =>
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight
  )

  React.useEffect(() => {
    let frame: number | null = null
    const evaluate = (): void => {
      frame = null
      setHeight((previous) => (previous === window.innerHeight ? previous : window.innerHeight))
    }

    evaluate()
    const handleResize = (): void => {
      if (frame === null) frame = requestAnimationFrame(evaluate)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  return height
}
