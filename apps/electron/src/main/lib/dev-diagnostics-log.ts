/**
 * 开发态诊断日志落盘（仅开发构建使用）。
 *
 * 设计约束：
 * - 必须异步写入：窗口拖拽期间主进程若被同步 I/O 阻塞，会让 renderer 重绘落后于原生
 *   窗口边框，反而制造出待调查的“边界不同步”现象；
 * - 每个文件只在首次写入时检查一次体积并轮转，避免每行都 stat；
 * - 失败静默降级，诊断能力绝不阻断正常功能。
 */

import { appendFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 单个诊断文件上限；超过即轮转（删除后重建），避免开发期无限增长。 */
export const DEV_DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024

const preparedFiles = new Set<string>()

/** 纯函数：便于单测覆盖轮转阈值判断。 */
export function shouldRotateDiagnosticsLog(sizeBytes: number, maxBytes = DEV_DIAGNOSTICS_MAX_BYTES): boolean {
  return sizeBytes >= maxBytes
}

async function prepareFile(filePath: string): Promise<void> {
  if (preparedFiles.has(filePath)) return
  preparedFiles.add(filePath)

  await mkdir(dirname(filePath), { recursive: true })
  const stats = await stat(filePath).catch(() => null)
  if (stats && shouldRotateDiagnosticsLog(stats.size)) {
    await rm(filePath, { force: true })
  }
}

/** 追加一条 JSON 记录；调用方无需 await，写入失败不影响业务流程。 */
export function appendDevDiagnostic(directory: string, fileName: string, record: unknown): void {
  const filePath = join(directory, fileName)
  void (async () => {
    try {
      await prepareFile(filePath)
      await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // 诊断日志失败必须静默：它是观测手段，不是业务依赖。
    }
  })()
}
