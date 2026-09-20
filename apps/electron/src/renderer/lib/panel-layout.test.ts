import { describe, expect, test } from 'bun:test'
import {
  CONVERSATION_MIN_WIDTH,
  FILE_PANEL_MIN_WIDTH,
  BROWSER_MIN_WIDTH,
  SIDEBAR_WIDTH,
  GAP_BUFFER,
  HYSTERESIS,
  PANE_SPLIT_GAP,
  computeVisibility,
  layoutNeed,
  mainAreaNeed,
  type PanelLayoutState,
  type PanelVisibility,
} from './panel-layout'
import { GROUP_SPLIT_GAP } from '@/atoms/tab-group-atoms'

const full: PanelLayoutState = { sidebar: true, filePanel: true, browser: true, mainPaneCount: 1 }
const noBrowser: PanelLayoutState = { sidebar: true, filePanel: true, browser: false, mainPaneCount: 1 }
const fpAndBrowser: PanelLayoutState = { sidebar: false, filePanel: true, browser: true, mainPaneCount: 1 }
const browserOnly: PanelLayoutState = { sidebar: false, filePanel: false, browser: true, mainPaneCount: 1 }
const fpOnly: PanelLayoutState = { sidebar: false, filePanel: true, browser: false, mainPaneCount: 1 }
const none: PanelLayoutState = { sidebar: false, filePanel: false, browser: false, mainPaneCount: 1 }

const hidden: PanelVisibility = { browser: false, filePanel: false }
const shown: PanelVisibility = { browser: true, filePanel: true }

describe('layoutNeed 各组合', () => {
  test('given all three panels open when computing need then returns 1396', () => {
    expect(layoutNeed(full)).toBe(
      CONVERSATION_MIN_WIDTH + SIDEBAR_WIDTH + FILE_PANEL_MIN_WIDTH + BROWSER_MIN_WIDTH + GAP_BUFFER,
    )
    expect(layoutNeed(full)).toBe(1396)
  })

  test('given no browser when computing need then returns 1036', () => {
    expect(layoutNeed(noBrowser)).toBe(1036)
  })

  test('given conversation only when computing need then returns 436', () => {
    expect(layoutNeed(none)).toBe(CONVERSATION_MIN_WIDTH + GAP_BUFFER)
    expect(layoutNeed(none)).toBe(436)
  })

  test('given browser only when computing need then returns 796', () => {
    expect(layoutNeed(browserOnly)).toBe(CONVERSATION_MIN_WIDTH + BROWSER_MIN_WIDTH + GAP_BUFFER)
    expect(layoutNeed(browserOnly)).toBe(796)
  })

  test('given file panel only when computing need then returns 736', () => {
    expect(layoutNeed(fpOnly)).toBe(736)
  })
})

describe('computeVisibility 收起优先级', () => {
  test('given wide window over full layout then both browser and file panel visible', () => {
    // 曾可见（prev=shown）时按普通阈值判定：1396 即可双开
    const vis = computeVisibility(1400, full, shown)
    expect(vis).toEqual({ browser: true, filePanel: true })
  })

  test('given wide window but previously hidden then hysteresis band applies', () => {
    // 从不可见恢复：浏览器需 1396+50=1446 才显示
    expect(computeVisibility(1445, full, hidden).browser).toBe(false)
    expect(computeVisibility(1446, full, hidden).browser).toBe(true)
  })

  test('given medium window then file panel visible but browser yields (browser first to give way)', () => {
    // 文件面板阈值 736+50=786 已过；浏览器阈值 1096+50=1146 未到
    const vis = computeVisibility(900, fpAndBrowser, hidden)
    expect(vis.filePanel).toBe(true)
    expect(vis.browser).toBe(false)
  })

  test('given narrow window then both hidden', () => {
    const vis = computeVisibility(700, fpAndBrowser, hidden)
    expect(vis).toEqual({ browser: false, filePanel: false })
  })

  test('given only browser intent then browser visible when wide enough', () => {
    // 无文件面板时浏览器阈值 = 436+360+50 = 846
    const vis = computeVisibility(900, browserOnly, hidden)
    expect(vis.browser).toBe(true)
  })

  test('given no browser intent then browser stays hidden', () => {
    const vis = computeVisibility(1400, noBrowser, shown)
    expect(vis.browser).toBe(false)
    expect(vis.filePanel).toBe(true)
  })

  test('given sidebar expanded then thresholds are raised accordingly', () => {
    // 左侧栏展开（300）时，文件面板从不可见恢复需 436+300+300+50 = 1086
    const layout: PanelLayoutState = { sidebar: true, filePanel: true, browser: false, mainPaneCount: 1 }
    const vis = computeVisibility(1086, layout, hidden)
    expect(vis.filePanel).toBe(true)
    expect(computeVisibility(1085, layout, hidden).filePanel).toBe(false)
  })
})

// ===== 主区栏数（组合 tab） =====

describe('mainAreaNeed 按主区栏数计算', () => {
  test('given单栏 then returns CONVERSATION_MIN_WIDTH', () => {
    expect(mainAreaNeed(1)).toBe(CONVERSATION_MIN_WIDTH)
    expect(mainAreaNeed(1)).toBe(420)
  })

  test('given两栏（组合）then adds pane split gap', () => {
    expect(mainAreaNeed(2)).toBe(CONVERSATION_MIN_WIDTH * 2 + PANE_SPLIT_GAP)
    expect(mainAreaNeed(2)).toBe(848)
  })

  test('given 非法栏数 then falls back to at least one pane', () => {
    expect(mainAreaNeed(0)).toBe(CONVERSATION_MIN_WIDTH)
    expect(mainAreaNeed(-3)).toBe(CONVERSATION_MIN_WIDTH)
    expect(mainAreaNeed(1.7)).toBe(CONVERSATION_MIN_WIDTH)
  })

  test('given pane split gap then matches group atoms (防止只改一边)', () => {
    expect(PANE_SPLIT_GAP).toBe(GROUP_SPLIT_GAP)
  })
})

describe('组合状态下的宽度预算', () => {
  const groupNoSidebar: PanelLayoutState = { sidebar: false, filePanel: true, browser: false, mainPaneCount: 2 }
  const groupWithSidebar: PanelLayoutState = { sidebar: true, filePanel: true, browser: false, mainPaneCount: 2 }

  test('given 组合 + 文件面板 when 1400px then file panel 不再被判「宽度够」', () => {
    // 组合（2 栏）+ 文件面板：848 + 16 + 300 = 1164（已可见时沿用它保持）
    expect(layoutNeed(groupNoSidebar)).toBe(1164)
    expect(computeVisibility(1400, groupNoSidebar, shown).filePanel).toBe(true)
    // 单栏时同一窗口只需 736，两者差异正是被修掉的那个缺陷
    expect(layoutNeed(fpOnly)).toBe(736)
  })

  test('given 组合 + 左栏 + 文件面板 when 1400px then file panel 让位', () => {
    // 848 + 300 + 16 + 300 = 1464 > 1400 → 收起
    expect(layoutNeed(groupWithSidebar)).toBe(1464)
    expect(computeVisibility(1400, groupWithSidebar, shown).filePanel).toBe(false)
    expect(computeVisibility(1464, groupWithSidebar, shown).filePanel).toBe(true)
  })

  test('given 组合 + 左栏 + 文件面板 when 从不可见恢复 then 需叠加滞后带', () => {
    expect(computeVisibility(1463, groupWithSidebar, hidden).filePanel).toBe(false)
    expect(computeVisibility(1514, groupWithSidebar, hidden).filePanel).toBe(true)
  })

  test('given 同一窗口在组合解散后 then 文件面板恢复可见（阈值回落）', () => {
    // 组合时 1400 不够；解散回单栏后 1400 ≥ 1036 → 可见（隐藏态需 +50）
    expect(computeVisibility(1400, groupWithSidebar, hidden).filePanel).toBe(false)
    expect(computeVisibility(1400, noBrowser, hidden).filePanel).toBe(true)
  })
})

describe('computeVisibility 滞后带（防抖动）', () => {
  test('given window oscillating around threshold then each switches only once', () => {
    const layout: PanelLayoutState = { sidebar: false, filePanel: true, browser: false, mainPaneCount: 1 }
    // 从不可见打开，需要 736+50=786
    expect(computeVisibility(785, layout, hidden).filePanel).toBe(false)
    expect(computeVisibility(786, layout, hidden).filePanel).toBe(true)
    // 已可见后缩回，736 以下才收起
    expect(computeVisibility(737, layout, shown).filePanel).toBe(true)
    expect(computeVisibility(735, layout, shown).filePanel).toBe(false)
  })

  test('given hysteresis constant then is 50', () => {
    expect(HYSTERESIS).toBe(50)
  })
})
