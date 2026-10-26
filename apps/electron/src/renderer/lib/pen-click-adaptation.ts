/**
 * 手写笔的点击适配
 *
 * 背景：侧栏会话、标签页、工作区分组都用 HTML5 `draggable`。鼠标按下后需要明显位移
 * 才会触发拖拽，但笔的抖动很容易越过阈值——想点会话，结果变成了拖动。
 *
 * 做法：笔（pointerType === 'pen'）落在 `[draggable="true"]` 元素上时，在 pointerdown
 * 阶段临时把 draggable 置为 false，抬手后恢复。这样这一下就是干净的点击，
 * 不会触发 dragstart；鼠标/触控板完全不受影响。
 *
 * 只读取事件、不 preventDefault，不干扰应用其它交互。
 */

const RESTORE_FLAG = 'data-pen-drag-suppressed'

export function installPenClickAdaptation(): () => void {
  let restoreTarget: HTMLElement | null = null

  const restore = (): void => {
    if (!restoreTarget) return
    restoreTarget.setAttribute('draggable', 'true')
    restoreTarget.removeAttribute(RESTORE_FLAG)
    restoreTarget = null
  }

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'pen') return
    const target = event.target
    if (!(target instanceof Element)) return

    const draggable = target.closest('[draggable="true"]')
    if (!(draggable instanceof HTMLElement)) return

    draggable.setAttribute('draggable', 'false')
    draggable.setAttribute(RESTORE_FLAG, '1')
    restoreTarget = draggable
  }

  const handlePointerUp = (): void => {
    // 放到下一个宏任务：让 click 先派发完再恢复，避免 React 重渲染把属性改回去
    if (!restoreTarget) return
    setTimeout(restore, 0)
  }

  window.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('pointerup', handlePointerUp, true)
  window.addEventListener('pointercancel', handlePointerUp, true)

  return () => {
    window.removeEventListener('pointerdown', handlePointerDown, true)
    window.removeEventListener('pointerup', handlePointerUp, true)
    window.removeEventListener('pointercancel', handlePointerUp, true)
    restore()
  }
}
