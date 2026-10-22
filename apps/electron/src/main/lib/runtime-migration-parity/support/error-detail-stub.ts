/**
 * runtime-migration-parity / 错误详情格式化替身
 *
 * 编排层 catch 块会用 `serializeErrorDetail` 打印真实错误。这个符号不能直接从
 * `../../agent-orchestrator` 取（那会造成 orchestrator → collaboration-tools → agent-service →
 * orchestrator 的模块循环，本套件的切片编译就是为此存在的），因此这里提供同形的登记替身：
 * 只把错误转成可读文本，不复制任何生产判定。
 */

/** 与 `serializeErrorDetail` 同形的诊断文本（不做栈裁剪，对照用例只看错误本体）。 */
export function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `[类型: ${error.constructor.name}] message: ${error.message} name: ${error.name}`
  }
  return `[非 Error] ${String(error)}`
}
