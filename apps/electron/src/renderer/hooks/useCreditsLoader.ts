/**
 * 额度加载 — 把服务端余额拉进 jotai atoms
 *
 * 统一三处对额度的读取：
 *   - 侧栏余额条（登录后展示 + 定时刷新）
 *   - 额度不足（402）后的即时刷新
 *   - 设置页额度概览
 *
 * 仅在代管模式（commercialMode）下有效；非代管模式直接清空余额。
 */
import * as React from 'react'
import { useSetAtom, useStore } from 'jotai'
import { creditsLoadingAtom, refreshCreditsInto } from '@/domains/credits/credits-state'

// 保留历史导出路径，组件外的调用方可直接使用领域状态入口。
export { refreshCreditsInto } from '@/domains/credits/credits-state'

/**
 * 在组件中加载并定时刷新余额。
 * @param pollMs 轮询间隔，默认 60s；传 0 关闭轮询
 */
export function useCreditsLoader(pollMs = 60_000): { reload: () => Promise<void> } {
  const store = useStore()
  const setLoading = useSetAtom(creditsLoadingAtom)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      await refreshCreditsInto(store)
    } finally {
      setLoading(false)
    }
  }, [store, setLoading])

  React.useEffect(() => {
    void reload()
    if (pollMs <= 0) return

    const timer = setInterval(() => { void reload() }, pollMs)
    const handleOnline = (): void => { void reload() }
    window.addEventListener('online', handleOnline)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', handleOnline)
    }
  }, [reload, pollMs])

  return { reload }
}
