/**
 * Grep 结果的折叠预览收敛
 *
 * Grep 结果按「文件 → 匹配行」分组渲染，无法像纯文本那样按行切分，
 * 必须显式收敛渲染量，否则折叠按钮只是个装饰：首帧就把全部匹配塞进 DOM，
 * 点展开/收看不到任何变化。
 */

export interface GrepPreviewMatch {
  file: string
  line: number
  content: string
}

export interface GrepPreviewGroup {
  file: string
  matches: GrepPreviewMatch[]
}

export interface GrepPreviewSlice {
  /** 折叠预览时要渲染的分组；未折叠时即传入的全部分组 */
  groups: GrepPreviewGroup[]
  /** 被折叠隐藏的匹配条数（用于提示用户还能展开看到多少） */
  hiddenMatches: number
}

/** 折叠预览时最多渲染的匹配条数 */
export const GREP_PREVIEW_MATCH_LIMIT = 200

/**
 * 按匹配条数收敛 Grep 分组。
 *
 * 以整组为单位尽量保留，最后一组按剩余额度截断，保证渲染量有上界。
 */
export function limitGrepGroupsForPreview(
  groups: GrepPreviewGroup[],
  collapsed: boolean,
  limit: number = GREP_PREVIEW_MATCH_LIMIT,
): GrepPreviewSlice {
  if (!collapsed) return { groups, hiddenMatches: 0 }

  const visibleGroups: GrepPreviewGroup[] = []
  let budget = Math.max(0, limit)
  let hiddenMatches = 0

  for (const group of groups) {
    if (budget <= 0) {
      hiddenMatches += group.matches.length
      continue
    }
    if (group.matches.length <= budget) {
      visibleGroups.push(group)
      budget -= group.matches.length
      continue
    }
    visibleGroups.push({ file: group.file, matches: group.matches.slice(0, budget) })
    hiddenMatches += group.matches.length - budget
    budget = 0
  }

  return { groups: visibleGroups, hiddenMatches }
}
