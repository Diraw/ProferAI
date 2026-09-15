/**
 * Windows 窗口按钮布局常量与宿主选择规则。
 *
 * 这里的数字和纯函数被三处共用：
 * 1. 需要在窗口按钮前面结束的拖拽层（drag region）；
 * 2. 需要为按钮预留右侧空间的内容区；
 * 3. 决定「谁渲染按钮」的宿主优先级。
 *
 * 为什么必须共用：Electron 的 app-region 命中区由操作系统合成，不能靠 z-index
 * 把重叠的 drag 矩形压到按钮下面。历史上 Windows 高 DPI（125%/150%/175%）出现的
 * 「窗口按钮单击无效、需要双击」正来自 drag 矩形覆盖按钮矩形（见提交 04090bbc）。
 * 因此凡是「在按钮前结束」的语义，都必须引用同一个宽度。
 */

/**
 * 窗口按钮安全宽度：三个 36px 按钮（108px）+ 容器左右内边距与边框（4px）+ 缓冲，
 * 向上取整到 126px。顶栏内的内联变体（34px 按钮）留出的余量更大，同样安全。
 *
 * 已知尚未改为引用本常量的字面量（属历史债务，改动需 Windows 真机验收）：
 * - `components/app-shell/AppShell.tsx`、`components/chat/ChatHeader.tsx`、`components/agent/TeamWorkspaceView.tsx`
 * - `components/diff/PreviewPanel.tsx`（本地常量）、`components/agent/SidePanel.tsx`、`components/browser/BrowserPanel.tsx`
 */
export const WINDOWS_WINDOW_CONTROLS_SAFE_WIDTH = 126

export interface WindowControlsHostRegistration {
  id: string
  /** 宿主当前是否可见并愿意接管窗口按钮。 */
  active: boolean
  /** 数值越大越靠近物理窗口右缘，越应优先接管按钮。 */
  priority: number
}

/**
 * 选出当前唯一持有窗口按钮的宿主。
 *
 * 规则：只考虑 active 宿主，priority 大者胜；priority 相同时保留先注册者
 * （与 Map 迭代顺序一致，避免同一帧内按钮在宿主之间来回跳）。
 *
 * 返回 null 表示当前没有任何宿主能提供窗口按钮。在 Windows 上这意味着
 * 最小化/最大化/关闭整组消失，属于回归信号而不是正常状态。
 */
export function selectActiveWindowControlsHost(
  hosts: Iterable<WindowControlsHostRegistration>,
): string | null {
  let selected: WindowControlsHostRegistration | null = null
  for (const host of hosts) {
    if (!host.active) continue
    if (selected && host.priority <= selected.priority) continue
    selected = host
  }
  return selected?.id ?? null
}

/**
 * 计算「必须为窗口按钮让开」的右侧宽度。
 *
 * 拖拽层和内容预留都应使用它，而不是各自写 126 或 118；这样按钮尺寸变化时
 * 只有本文件需要改。
 */
export function resolveWindowControlsRightInset(
  controlsVisible: boolean,
  safeWidth: number = WINDOWS_WINDOW_CONTROLS_SAFE_WIDTH,
): number {
  if (!controlsVisible) return 0
  return Math.max(0, safeWidth)
}
