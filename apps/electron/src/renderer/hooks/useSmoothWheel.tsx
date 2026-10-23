/**
 * Windows 鼠标滚轮平滑滚动的挂载点
 *
 * 只在 Windows 且用户开启「平滑滚动」时安装全局 wheel 接管；
 * 关闭时真正移除监听器（非 passive 监听会持续影响合成器滚动，不能只做逻辑短路）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { detectIsWindows } from '@profer/ui'
import { smoothScrollEnabledAtom } from '@/atoms/ui-preferences'
import { installSmoothWheel } from '@/lib/smooth-wheel'

export function SmoothWheelInitializer(): null {
  const enabled = useAtomValue(smoothScrollEnabledAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  React.useEffect(() => {
    if (!isWindows || !enabled) return
    return installSmoothWheel()
  }, [isWindows, enabled])

  return null
}
