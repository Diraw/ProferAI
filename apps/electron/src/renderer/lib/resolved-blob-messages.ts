/**
 * 被外部化消息的「完整版覆盖」。
 *
 * 落盘时超限消息里的大载荷被搬到 blob，行内只留片段；用户在界面上点「加载全文」后，
 * 渲染层才通过 IPC 取回原文。取回的结果按 uuid 存在 `resolvedBlobMessagesAtom` 里，
 * 由这一层覆盖回消息流——下游（turn 分组、工具结果查找、任务映射）无需任何改动。
 *
 * 抽成纯函数是为了可测：覆盖逻辑最容易出错的地方是「按什么键匹配」与
 * 「没有 uuid 的消息怎么办」，这两点都有测试固定。
 */

/** 按 uuid 覆盖为完整版。没有 uuid 的消息无法定位，原样返回。 */
export function applyResolvedBlobMessages<T extends object>(
  messages: T[],
  overrides: Map<string, unknown>,
): T[] {
  if (overrides.size === 0) return messages
  let changed = false
  const next = messages.map((message) => {
    const uuid = (message as { uuid?: unknown }).uuid
    if (typeof uuid !== 'string') return message
    const resolved = overrides.get(uuid)
    if (!resolved || resolved === message) return message
    changed = true
    return resolved as T
  })
  // 没有任何一条命中时不换数组引用，避免下游 useMemo 无谓失效
  return changed ? next : messages
}
