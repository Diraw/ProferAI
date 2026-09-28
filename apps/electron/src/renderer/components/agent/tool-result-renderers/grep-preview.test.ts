import { describe, expect, test } from 'bun:test'
import { GREP_PREVIEW_MATCH_LIMIT, limitGrepGroupsForPreview, type GrepPreviewGroup } from './grep-preview'

/** 按每个文件的匹配条数构造分组 */
function makeGroups(counts: number[]): GrepPreviewGroup[] {
  return counts.map((count, index) => ({
    file: `src/file-${index}.ts`,
    matches: Array.from({ length: count }, (_, i) => ({
      file: `src/file-${index}.ts`,
      line: i + 1,
      content: `match ${i}`,
    })),
  }))
}

describe('Grep 折叠预览收敛', () => {
  test('Given 未折叠 When 收敛 Then 原样返回全部分组', () => {
    const groups = makeGroups([3, 4])
    const slice = limitGrepGroupsForPreview(groups, false)
    expect(slice.groups).toBe(groups)
    expect(slice.hiddenMatches).toBe(0)
  })

  test('Given 折叠且匹配数超出上限 When 收敛 Then 渲染量有界并报告隐藏条数', () => {
    const slice = limitGrepGroupsForPreview(makeGroups([120, 120, 120]), true)
    const rendered = slice.groups.reduce((sum, group) => sum + group.matches.length, 0)
    expect(rendered).toBe(GREP_PREVIEW_MATCH_LIMIT)
    expect(slice.hiddenMatches).toBe(360 - GREP_PREVIEW_MATCH_LIMIT)
  })

  test('Given 折叠但匹配数在上限内 When 收敛 Then 不隐藏任何匹配', () => {
    const slice = limitGrepGroupsForPreview(makeGroups([10, 10]), true)
    expect(slice.groups).toHaveLength(2)
    expect(slice.hiddenMatches).toBe(0)
  })

  test('Given 截断落在分组中间 When 收敛 Then 该组按剩余额度截断', () => {
    const slice = limitGrepGroupsForPreview(makeGroups([100, 100]), true, 150)
    expect(slice.groups.map((group) => group.matches.length)).toEqual([100, 50])
    expect(slice.hiddenMatches).toBe(50)
  })
})
