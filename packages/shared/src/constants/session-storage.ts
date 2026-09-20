/**
 * 会话存储中「大载荷外部化」的字段契约。
 *
 * 落盘时，超过行上限的消息里的大字符串会被搬到 blob（内容寻址存储），
 * 行内只留片段，并在消息顶层写一份引用表。渲染层在用户点击「加载全文」时，
 * 按这份引用表把片段换回原文。
 *
 * 字段名必须两边共用**同一个常量**：历史上「同一套规则散在多处、各自漏一处」
 * 已经造成过一次事故（落盘截断的 4 个覆盖缺口），这里不重蹈。
 */

/** 消息顶层的引用表字段名 */
export const SESSION_BLOB_REFS_FIELD = '_proferBlobs'

/** 还原失败时记录缺失引用的字段名（渲染层据此提示「原文不可用」） */
export const SESSION_BLOB_MISSING_FIELD = '_proferBlobsMissing'

/** 引用表里的一条 */
export interface SessionBlobRef {
  /** 相对消息根的对象路径，如 `tool_use_result.content[0].text` */
  path: string
  /** 内容哈希，形如 `sha256:<hex>` */
  hash: string
  /** 原始字符串长度（chars） */
  chars: number
  /** 原始字符串字节数 */
  bytes: number
}

/** 从消息里读出引用表；没有或形状不对时返回空数组 */
export function readSessionBlobRefs(message: unknown): SessionBlobRef[] {
  if (typeof message !== 'object' || message === null) return []
  const refs = (message as Record<string, unknown>)[SESSION_BLOB_REFS_FIELD]
  if (!Array.isArray(refs)) return []
  return refs.filter(
    (ref): ref is SessionBlobRef =>
      typeof ref === 'object' && ref !== null
      && typeof (ref as SessionBlobRef).path === 'string'
      && typeof (ref as SessionBlobRef).hash === 'string',
  )
}
