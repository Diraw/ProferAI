import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rendererRoot = resolve(import.meta.dir, '../..')
const agentView = readFileSync(resolve(rendererRoot, 'components/agent/AgentView.tsx'), 'utf8')
const border = readFileSync(resolve(rendererRoot, 'components/agent/PlanModeDashedBorder.tsx'), 'utf8')
const skinBase = readFileSync(resolve(rendererRoot, 'styles/skin-base.css'), 'utf8')

test('计划模式边框保留原 SVG 视觉实现并在计划态挂载', () => {
  expect(agentView).toContain("(isPlanMode || isPermissionPlanMode) && !isDragOver && <PlanModeDashedBorder />")
  expect(border).toContain('const DASH_LENGTH = 9')
  expect(border).toContain('const DASH_GAP = 7')
  expect(border).toContain('const STROKE_WIDTH = 2')
  expect(border).toContain('const OFFSET = 2')
  expect(border).toContain('strokeDasharray={`${DASH_LENGTH} ${DASH_GAP}`}')
  expect(border).toContain('strokeWidth={STROKE_WIDTH}')
  expect(border).toContain('strokeLinecap="round"')
  expect(border).toContain('pointer-events-none')
  expect(border).toContain('ResizeObserver')
  expect(border).toContain('<svg')
})

test('虚线中心线与宿主外边框同心，半径实测而非硬编码', () => {
  // 硬编码 19 = 17 + 2 会让圆角弧线与宿主外边框错位，在四角表现为「斜切 / 多出一角」。
  // 同心条件：虚线中心线半径 = 宿主半径 + (OFFSET - STROKE_WIDTH / 2)。
  expect(border).toContain('const dashedRadius = metrics.radius + OFFSET - STROKE_WIDTH / 2')
  expect(border).toContain('rx={dashedRadius}')
  expect(border).not.toContain('rx={BORDER_RADIUS + OFFSET}')
  // 半径与边框宽度都必须取自计算样式，适配经典界面 --radius 与终端主题 border-radius: 0。
  expect(border).toContain('getComputedStyle(parent)')
  expect(border).toContain('style.borderTopLeftRadius')
  expect(border).toContain('style.borderTopWidth')
  // 终端主题是合法的 border-radius: 0，不能被 `|| 17` 误当成缺失值。
  expect(border).toContain('Number.isFinite(parsed) ? parsed : FALLBACK_RADIUS')
  // 绝对定位基准是 padding box，量的是 border box，两者相差宿主边框宽度。
  expect(border).toContain('const wrapperInset = -(OFFSET + metrics.borderWidth)')
})

test('皮肤未定义专用描边 token 时回落到 primary 颜色', () => {
  expect(skinBase).toContain('stroke: var(--plan-mode-stroke-color, hsl(var(--primary) / 0.45));')
})
