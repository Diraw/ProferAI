import * as React from 'react'

/**
 * 读取「Tab 标签本体下沿」相对侧栏顶部的距离。
 *
 * 侧栏列表容器的顶边必须与 Tab 顶栏里标签本体的下沿重合。这个距离由三部分决定：
 * 主区的 8px 内边距、TabBar 40px 外框里的 1px 内容偏移与 37px 内容行高，
 * 以及窗口缩放。写成常量在布局微调后会静默漂移（已经漂过一次），所以直接量真实 DOM。
 *
 * 量不到时（首帧、主区尚未挂载）回退到常量，量到后立即校正。
 */
export function useTabBarBottomOffset(fallback: number): number {
  const [offset, setOffset] = React.useState(fallback)

  React.useEffect(() => {
    const measure = (): void => {
      const content = document.querySelector<HTMLElement>('[data-profer-tabbar-content]')
      const sidebar = document.querySelector<HTMLElement>('[data-profer-sidebar]')
      if (!content || !sidebar) return
      const next = Math.round(
        content.getBoundingClientRect().bottom - sidebar.getBoundingClientRect().top,
      )
      // 只接受正数：窗口最小化/隐藏时 rect 可能全为 0，避免把侧栏顶到负偏移。
      if (next <= 0) return
      setOffset((previous) => (previous === next ? previous : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    const content = document.querySelector<HTMLElement>('[data-profer-tabbar-content]')
    const sidebar = document.querySelector<HTMLElement>('[data-profer-sidebar]')
    if (content) observer.observe(content)
    if (sidebar) observer.observe(sidebar)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return offset
}
