/**
 * @profer/office-engine — 主入口（仅类型，浏览器安全）
 *
 * 本入口**只导出类型**，零运行时符号，编译后完全擦除，可被渲染层安全 import。
 * 运行时能力（依赖 node:zlib）在子入口 '@profer/office-engine/node'，
 * 仅供 Electron 主进程与 CLI 使用。
 *
 * 采用与 '@profer/session-core'（主入口纯函数 + './node' 子入口做文件 IO）一致的约定，
 * 理由：子路径是 `check-boundaries` 规则 4 能校验的，而「根入口只导类型」门禁查不到，
 * 靠 subpath 显式隔离比靠约定更可靠。
 *
 * 来源：移植自 CDUT Studio `packages/core/src/office-engine`（@ c83c6a45）。
 */

export type {
  OfficeFormat,
  OfficeBlockType,
  OfficeLayoutBlock,
  OfficePageLayout,
  OfficeDocumentLayoutAST,
  OfficeParseOptions,
  OfficeParseResult,
} from './types'
