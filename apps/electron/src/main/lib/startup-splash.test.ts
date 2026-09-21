import { expect, test } from 'bun:test'

import { createCenteredStartupSplashBounds, createStartupSplashHtml } from './startup-splash'

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
