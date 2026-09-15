import { describe, expect, test } from 'bun:test'
import {
  WINDOWS_WINDOW_CONTROLS_SAFE_WIDTH,
  resolveWindowControlsRightInset,
  selectActiveWindowControlsHost,
  type WindowControlsHostRegistration,
} from './window-controls-layout'

function host(id: string, active: boolean, priority: number): WindowControlsHostRegistration {
  return { id, active, priority }
}

describe('窗口按钮宿主选择', () => {
  test('只有 active 宿主参与竞争', () => {
    const hosts = [host('tab-bar', false, 10), host('preview-panel', true, 20)]
    expect(selectActiveWindowControlsHost(hosts)).toBe('preview-panel')
  })

  test('priority 高者接管按钮', () => {
    // 右侧文件栏(30) 压在普通顶栏(10) 之上，符合「谁贴窗口右缘谁负责」的约定
    const hosts = [host('tab-bar', true, 10), host('right-side-panel', true, 30)]
    expect(selectActiveWindowControlsHost(hosts)).toBe('right-side-panel')
  })

  test('priority 相同时保留先注册者，避免按钮在宿主间跳动', () => {
    const hosts = [host('first', true, 20), host('second', true, 20)]
    expect(selectActiveWindowControlsHost(hosts)).toBe('first')
  })

  test('没有 active 宿主时返回 null（Windows 上即按钮整组消失）', () => {
    expect(selectActiveWindowControlsHost([])).toBeNull()
    expect(selectActiveWindowControlsHost([host('a', false, 10), host('b', false, 40)])).toBeNull()
  })

  test('全部宿主 active 时与注册顺序无关，始终选出最高优先级', () => {
    const hosts = [
      host('main-content', true, 10),
      host('browser-panel', true, 20),
      host('team-files', true, 40),
      host('right-side-panel', true, 30),
    ]
    expect(selectActiveWindowControlsHost(hosts)).toBe('team-files')
  })
})

describe('窗口按钮安全宽度', () => {
  test('三个 36px 按钮加容器内边距与边框后仍小于安全宽度', () => {
    // .window-control-btn 36px × 3 + .window-controls 左右 padding 2px + 边框 2px
    const controlsWidth = 36 * 3 + 2 + 2
    expect(controlsWidth).toBeLessThanOrEqual(WINDOWS_WINDOW_CONTROLS_SAFE_WIDTH)
  })

  test('按钮隐藏时不需要让开空间', () => {
    expect(resolveWindowControlsRightInset(false)).toBe(0)
    expect(resolveWindowControlsRightInset(true)).toBe(WINDOWS_WINDOW_CONTROLS_SAFE_WIDTH)
  })

  test('非法安全宽度不会产生负偏移', () => {
    expect(resolveWindowControlsRightInset(true, -40)).toBe(0)
  })
})
