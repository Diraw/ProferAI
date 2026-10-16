export interface ProcessCollapseLifecycleState {
  active: boolean
  collapseScheduled: boolean
  collapseDone: boolean
}

/**
 * 判断过程组是否应撤销上一轮自动折叠。
 *
 * stream false 可能只是终态落盘、刷新恢复或下一轮启动之间的过渡，不代表
 * 这个 React 组件对应的过程组生命周期已经结束。只要重新进入 active，就不能
 * 让上一轮遗留的 timer 在当前输出中卸载内容。
 */
export function shouldRestartProcessCollapse(state: ProcessCollapseLifecycleState): boolean {
  return state.active && (state.collapseScheduled || state.collapseDone)
}
