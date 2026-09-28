/**
 * coach-tour-owner — CoachTour 跨窗口单例锁
 *
 * 背景：应用允许同时存在多个完整主窗口，每个窗口的 App 初始化都会执行
 * 「引导版本落后 → 自动开播」，导致两个窗口各自渲染引导卡片、step 互不同步。
 *
 * 方案：localStorage 互斥（同一应用各窗口共享存储分区）——
 *  - 占位：open 时写入 { owner: windowId, ts }，已有其他窗口的新鲜锁直接让位
 *  - 竞态：双窗口几乎同时写入时后者覆盖前者，写入方 120ms 后回读校验，
 *    不是自己则回调 onLost 让位（后写者赢）
 *  - 心跳：持有方每 3s 续期；窗口崩溃遗留的锁 8s 后视为过期可回收
 *  - 后来者：storage 事件监听，别的窗口拿到锁时回调 onLost
 */

const OWNER_KEY = 'profer:coach-tour-owner'
const STALE_MS = 8000
const HEARTBEAT_MS = 3000
const VERIFY_DELAY_MS = 120

const windowId = crypto.randomUUID()

interface OwnerRecord {
  owner: string
  ts: number
}

function readOwner(): OwnerRecord | null {
  try {
    const raw = localStorage.getItem(OWNER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OwnerRecord>
    if (typeof parsed.owner !== 'string' || typeof parsed.ts !== 'number') return null
    return { owner: parsed.owner, ts: parsed.ts }
  } catch {
    return null
  }
}

function writeOwner(): void {
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify({ owner: windowId, ts: Date.now() } satisfies OwnerRecord))
  } catch {
    // 存储不可用时视为无锁环境（单窗口场景），不阻断引导
  }
}

export interface CoachTourOwnership {
  release: () => void
}

/** 尝试取得引导播放权；已被他窗口持有返回 null，持有期间被抢走回调 onLost */
export function claimCoachTourOwnership(onLost: () => void): CoachTourOwnership | null {
  const existing = readOwner()
  if (existing && existing.owner !== windowId && Date.now() - existing.ts < STALE_MS) {
    return null
  }

  writeOwner()
  const heartbeat = window.setInterval(writeOwner, HEARTBEAT_MS)
  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== OWNER_KEY) return
    const other = readOwner()
    if (other && other.owner !== windowId && Date.now() - other.ts < STALE_MS) {
      onLost()
    }
  }
  window.addEventListener('storage', handleStorage)
  const verifyTimer = window.setTimeout(() => {
    const current = readOwner()
    if (current && current.owner !== windowId) onLost()
  }, VERIFY_DELAY_MS)

  return {
    release() {
      window.clearInterval(heartbeat)
      window.clearTimeout(verifyTimer)
      window.removeEventListener('storage', handleStorage)
      const current = readOwner()
      if (current && current.owner === windowId) {
        try {
          localStorage.removeItem(OWNER_KEY)
        } catch {
          // 同上，存储不可用时忽略
        }
      }
    },
  }
}
