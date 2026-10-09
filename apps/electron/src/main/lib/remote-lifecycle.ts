import type { Server } from 'node:http'
import type { ChildProcess } from 'node:child_process'
/** 顺序执行生命周期请求，失败不会阻塞后续恢复操作。 */
export class RemoteLifecycleQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}
export function closeOwnedHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
    server.closeAllConnections()
  })
}
/** 只操作传入的 owned 句柄；等待真正 exit，超时升级 SIGKILL，仍不退出则拒绝新启动。 */
export function waitForOwnedExit(proc: ChildProcess, graceMs = 2000, killMs = 2000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => { clearTimeout(graceTimer); if (killTimer) clearTimeout(killTimer); proc.removeListener('exit', finish); resolve() }
    const graceTimer = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) { finish(); return }
      killTimer = setTimeout(() => { proc.removeListener('exit', finish); reject(new Error('owned FRP 进程未退出，拒绝启动新实例')) }, killMs)
      try { proc.kill('SIGKILL') } catch { if (killTimer) clearTimeout(killTimer); proc.removeListener('exit', finish); reject(new Error('owned FRP 强制停止失败')) }
    }, graceMs)
    proc.once('exit', finish)
    try { proc.kill() } catch { clearTimeout(graceTimer); proc.removeListener('exit', finish); reject(new Error('owned FRP 停止失败')) }
  })
}
