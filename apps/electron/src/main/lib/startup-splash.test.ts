import { expect, test } from 'bun:test'

import { createCenteredStartupSplashBounds, createStartupSplashHtml, SPLASH_READY_TITLE } from './startup-splash'

test('centers the initial Splash at one quarter of the selected display work area', () => {
  expect(createCenteredStartupSplashBounds(
    { x: 0, y: 0, width: 1920, height: 1080 },
  )).toEqual({ x: 720, y: 405, width: 480, height: 270 })

  expect(createCenteredStartupSplashBounds(
    { x: 1920, y: 40, width: 2560, height: 1440 },
  )).toEqual({ x: 2880, y: 580, width: 640, height: 360 })
})

test('emits a themed original WebGL startup splash', () => {
  const darkHtml = createStartupSplashHtml(true)
  const lightHtml = createStartupSplashHtml(false)

  expect(darkHtml).toContain('<canvas id="fluid"></canvas>')
  expect(darkHtml).toContain('getContext(\'webgl\'')
  expect(darkHtml).toContain('background:#0b0b0c')
  expect(darkHtml).toContain('-webkit-app-region:drag')
  expect(darkHtml).toContain('user-select:none')
  expect(darkHtml).toContain('-webkit-user-select:none')
  expect(lightHtml).toContain('background:#f7f7f5')
})

test('uses the original shader and a size-synchronized canvas', () => {
  const html = createStartupSplashHtml(true)

  expect(html).toContain('float splashValue(')
  expect(html).toContain('float s0 = splashValue')
  expect(html).toContain('float s1 = splashValue')
  expect(html).toContain('float s2 = splashValue')
  expect(html).toContain('getBoundingClientRect()')
  expect(html).toContain('new ResizeObserver(resize).observe(c)')
  expect(html).toContain('gl.uniform1f(continuous,0)')
  expect(html).toContain('requestAnimationFrame(draw)')
})

test('首帧提交后才回报就绪信号，避免纯色窗口先闪现', () => {
  const html = createStartupSplashHtml(true)

  expect(html).toContain(`document.title='${SPLASH_READY_TITLE}'`)
  // 首帧 drawArrays 之后延一帧再回报，确保该帧已经交给合成器，而不是刚提交就 show
  expect(html).toContain('gl.drawArrays(gl.TRIANGLE_STRIP,0,4);if(!readySent)requestAnimationFrame(signalReady)')
})

test('WebGL 不可用或着色器失败时仍回报就绪，不会把启动流程卡死', () => {
  const html = createStartupSplashHtml(false)

  // 四个早退分支都必须先发信号：无 WebGL 上下文 / 着色器编译失败 / 链接失败 / uniform 缺失
  expect(html).toContain('if(!gl){signalReady();return}')
  expect(html).toContain('if(!v||!f){signalReady();return}')
  expect(html).toContain('if(!gl.getProgramParameter(p,gl.LINK_STATUS)){signalReady();return}')
  expect(html).toContain('if(!b||a<0||!time||!res||!op||!seed||!theme||!continuous){signalReady();return}')
})
