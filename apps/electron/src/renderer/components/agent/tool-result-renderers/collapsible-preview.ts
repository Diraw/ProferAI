/**
 * 工具结果折叠预览的纯逻辑
 *
 * 折叠判定与预览切片必须出自同一次计算：判定按字符数、切片按行数时，
 * 「超长但行数很少」的内容（minified JSON、单行 PowerShell、heredoc）
 * 会被判定为需要折叠，切片却返回全文，等于没有折叠。
 *
 * 这里让预览同时受两个维度约束：
 * - 任一维度超限即折叠
 * - 初始折叠态先取前 previewLines 行，再按 maxChars 封顶
 * - 用户主动展开后只按行数推进（渐进展开），不再叠加字符封顶
 */

export interface ResultPreviewOptions {
  /** 字符数上界：超过即折叠，初始预览也不会超过它 */
  maxChars: number
  /** 行数上界：超过即折叠，初始预览只取前 N 行 */
  previewLines: number
  /**
   * 是否允许按行数折叠，默认 true。
   *
   * 传 false 时只有字符数一条轴参与判定，且「全部展开」可突破字符上界拿到全文。
   * 适用于自带纵向滚动容器、由容器而非折叠控件限高的渲染器
   * （Read 代码视图、带 max-h 的文本块）——它们再按行折叠会与内部滚动重复。
   */
  foldByLines?: boolean
}

export interface ResultPreview {
  /** 用于渲染的文本：未折叠时是原文，折叠时是预览片段 */
  text: string
  /** 是否需要折叠（折叠控件出现，且 text 只是片段） */
  collapsed: boolean
}

export interface ResultWindowOptions extends ResultPreviewOptions {
  /**
   * 展开态要显示的行数；传 Number.POSITIVE_INFINITY 表示全部。
   *
   * 小于等于 previewLines 时按「初始折叠态」处理，字符封顶生效；
   * 大于 previewLines 时是用户主动展开，只受行数约束。
   */
  revealedLines: number
}

export interface ResultWindow extends ResultPreview {
  /** 当前 text 仍不是全文，即 renderContent 的 collapsed 参数 */
  truncated: boolean
  /** 还有未显示的行 */
  hasMoreLines: boolean
  /** 当前决定渲染的行数（因字符封顶可能实际显示的更少） */
  visibleLines: number
  /** 总行数（按 \r?\n 切分） */
  totalLines: number
}

/** 是否为 UTF-16 高位代理（0xD800-0xDBFF） */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** 按字符截断；落在代理对中间时回退一位，避免孤立代理渲染成 U+FFFD */
function sliceAtBoundary(text: string, maxChars: number): string {
  const end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars
  return text.slice(0, end)
}

/**
 * 计算工具结果在「折叠 / 渐进展开 / 全部展开」下的渲染窗口。
 *
 * 切行统一按 `\r?\n`，预览再以 `\n` 连接：Windows 输出的 CRLF 不会在预览里
 * 残留 `\r`（`whitespace-pre-wrap` 下 `\r` 也被当作换行，会多出空行）。
 */
export function sliceResultWindow(
  content: string,
  options: ResultWindowOptions,
): ResultWindow {
  const safeContent = content ?? ''
  const maxChars = Math.max(0, options.maxChars)
  const foldByLines = options.foldByLines !== false
  const lines = safeContent.split(/\r?\n/)
  const totalLines = lines.length

  const collapsed = safeContent.length > maxChars
    || (foldByLines && totalLines > options.previewLines)
  if (!collapsed) {
    return {
      text: safeContent,
      collapsed: false,
      truncated: false,
      hasMoreLines: false,
      visibleLines: totalLines,
      totalLines,
    }
  }

  // 仅字符轴：没有「行」可推进，折叠态就是前 maxChars 个字符，展开态即全文。
  // 这条分支必须在下面按行切的逻辑之前返回，否则 previewLines 与「已全部展开」
  // 同为最大值时 initialPreview 恒为 true，会导致「全部展开」点了没反应。
  if (!foldByLines) {
    const expanded = options.revealedLines > options.previewLines
    return {
      text: expanded ? safeContent : sliceAtBoundary(safeContent, maxChars),
      collapsed: true,
      truncated: !expanded,
      hasMoreLines: false,
      visibleLines: totalLines,
      totalLines,
    }
  }

  const revealed = Math.min(Math.max(options.revealedLines, 0), totalLines)
  const hasMoreLines = revealed < totalLines
  const initialPreview = options.revealedLines <= options.previewLines

  const head = (initialPreview ? lines.slice(0, options.previewLines) : lines.slice(0, revealed)).join('\n')
  const text = initialPreview && head.length > maxChars ? sliceAtBoundary(head, maxChars) : head

  return {
    text,
    collapsed,
    truncated: initialPreview || hasMoreLines,
    hasMoreLines,
    visibleLines: revealed,
    totalLines,
  }
}

/**
 * 是否应当提供「再显示 N 行」。
 *
 * 剩余行数不足一个步长时（含恰好等于），点它与点「全部展开」结果相同，
 * 两个按钮重复，只保留后者。步长传 0（未启用渐进展开）时始终不提供。
 */
export function canRevealByStep(resultWindow: ResultWindow, revealStep: number): boolean {
  if (revealStep <= 0) return false
  return resultWindow.totalLines - resultWindow.visibleLines > revealStep
}

/** 展开进度的度量方式与数值 */
export interface RevealProgress {
  /** 当前已展示的量 */
  revealed: number
  /** 总量 */
  total: number
  /** 尚未展示的量，即「全部展开」还能补上多少 */
  remaining: number
  /** 度量单位 */
  unit: '行' | '字符'
}

/**
 * 描述展开进度。
 *
 * 行数超过预览行数时以「行」度量；单行超长内容（minified JSON、heredoc 单行脚本）
 * 行数不足以表达进度，只能以「字符」度量。
 *
 * remaining 描述的是「全部展开」这一步的动作量，比总量更贴近按钮语义 —— 用户看到
 * 「还剩 52 行」时知道点下去会多出多少，看到总量还得自己减去已显示的部分。
 */
export function describeRevealProgress(
  resultWindow: ResultWindow,
  content: string,
  previewLines: number,
  foldByLines = true,
): RevealProgress {
  const usesLines = foldByLines && resultWindow.totalLines > previewLines
  const revealed = usesLines ? resultWindow.visibleLines : resultWindow.text.length
  const total = usesLines ? resultWindow.totalLines : content.length

  return {
    revealed,
    total,
    remaining: total - revealed,
    unit: usesLines ? '行' : '字符',
  }
}

/**
 * 只区分「折叠 / 展开」两态时的简化入口。
 *
 * 等价于 sliceResultWindow 在 revealedLines === previewLines 下的结果，
 * 供不提供渐进展开的调用方使用。
 */
export function sliceResultPreview(
  content: string,
  options: ResultPreviewOptions,
): ResultPreview {
  const { text, collapsed } = sliceResultWindow(content, {
    ...options,
    revealedLines: options.previewLines,
  })
  return { text, collapsed }
}
