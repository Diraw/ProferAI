/**
 * coach-tour-steps — 界面蒙层引导的步骤定义
 *
 * 每步给出按优先级排列的 CSS 选择器，引擎取第一个「可见且非零尺寸」
 * 的元素作为高亮锚点；全部找不到时气泡居中降级，不阻断流程。
 *
 * unionSelectors：锚点由多个分散容器组成（如技能页 = 头部 + 内容区两个并列
 * max-w-6xl 列，没有公共可见父级）时，对所有命中元素取外接矩形。
 *
 * view：进入该步前先把主内容区切到对应视图，保证锚点在正确的上下文里；
 * 引导退出时引擎会恢复用户原来的视图。
 *
 * advanceOn: 'click-anchor' 表示交互步骤——聚光灯镂空放行真实点击，
 * 等用户自己点击高亮区域（如侧栏入口）后才前进，让用户亲手走到目标页面；
 * 此时隐藏「下一步」按钮（锚点缺失时降级为手动下一步，不会卡住）。
 *
 * 改动提示：增删步骤或大改文案时 +1 CURRENT_COACH_TOUR_VERSION，
 * 已看过的用户升级后会自动重播一次新版本。
 */

import type { ActiveView } from '@/atoms/active-view'
import type { CoachTourPlacement } from './coach-tour-position'

export interface CoachTourStep {
  key: string
  title: string
  body: string
  /** 依次尝试的 CSS 选择器；第一个可见元素作为高亮目标 */
  selectors: string[]
  /** 气泡相对目标的偏好方位；空间不足时自动回退其他方位，auto 优先下方 */
  placement: CoachTourPlacement
  /** 进入该步前切换的主内容区视图；缺省不切 */
  view?: ActiveView
  /** 缺省为手动「下一步」；'click-anchor' 需用户亲自点击高亮锚点才前进 */
  advanceOn?: 'click-anchor'
  /** 提供时取代 selectors：对所有命中元素取外接矩形作为锚点 */
  unionSelectors?: string[]
}

export const COACH_TOUR_STEPS: CoachTourStep[] = [
  {
    key: 'mode-switch',
    title: '两种工作模式',
    body: 'Agent 模式让它自主规划并执行多步任务——查资料、改文件、跑命令都能独立完成，适合「帮我做件事」；Chat 模式专注轻量问答。两边会话互相独立，切换后自动恢复各自上次的进度，⌘B 可以随时收起侧栏专注内容。',
    selectors: ['[data-tour="mode-switch"]', '[data-profer-navigation-region="mode-switcher"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'new-session',
    title: '新建会话',
    body: '每个任务开一个会话，上下文干净、互不干扰。会话保留在左侧列表里随时切回继续；常用会话可以置顶，也可以并排打开两个 Tab 对照处理，搜索框能快速找回任何历史会话。',
    selectors: ['[data-profer-navigation-item="new-session"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'chat-input',
    title: '输入区',
    body: '用自然语言描述目标就好。四个引用让它基于真实上下文回答：@ 引用工作区文件，/ 调用 Skill，# 调用 MCP 工具，& 引用其他会话；支持粘贴图片和语音输入，超长文本自动转为附件。点进输入框感受一下。',
    selectors: ['[data-input-mode="chat"]', '[data-input-mode="agent"]'],
    placement: 'top',
    view: 'conversations',
    advanceOn: 'click-anchor',
  },
  {
    key: 'model-selector',
    title: '切换模型',
    body: '不同任务适合不同模型：写作、分析、编程各有所长。这里随时为当前会话切换模型，即刻生效；还可以在设置里为 Agent 会话配置长期默认模型和常用渠道。',
    selectors: ['.model-selector-trigger'],
    placement: 'top',
    view: 'conversations',
  },
  {
    key: 'planning-enter',
    title: '规划中心',
    body: '重复的活儿交给定时任务：每周一整理项目进展、每天早上汇总今日安排，到点自动执行。点这里，我们进去看看。',
    selectors: ['[data-profer-navigation-item="planning"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'planning-view',
    title: '任务、日程、定时任务',
    body: 'Todo、日程和定时任务统一在这里：待办可以排进日程，定时任务跑完会把结果直接写回会话并推送提醒，你不用盯进度。右上角「新建」（⌘N）支持 Todo、日程、定时任务三种入口。',
    selectors: ['[data-tour="planning-panel"]', '[data-profer-navigation-region="planning"]'],
    placement: 'auto',
  },
  {
    key: 'skills-enter',
    title: 'Agent 技能',
    body: '把你的最佳实践沉淀成 Skill，一次写好、反复调用——比如「按我的模板写周报」。点这里，我们进去看看。',
    selectors: ['[data-profer-navigation-item="agent-skills"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'skills-view',
    title: '技能库与岗位',
    body: '这里集中管理 Skills、MCP 工具、工作区记忆和岗位预设：内置技能开箱即用，「新建 Skill」能把一次成功的任务沉淀成模板；开关控制它在哪些会话生效，预设让 Agent 按特定角色工作。',
    selectors: [],
    unionSelectors: ['[data-tour="agent-skills-header"]', '[data-tour="agent-skills-panel"]'],
    placement: 'auto',
  },
  {
    key: 'outro',
    title: '开始你的第一个任务',
    body: '最能感受 Profer 的起点：切到 Agent 模式，让它「分析工作区里的一个文件并给出结论」，观察它如何自己规划和执行。这段引导随时可以从顶栏指南针按钮或设置里重播。',
    selectors: [],
    placement: 'auto',
  },
]

/** 引导内容版本：增删步骤/大改文案时 +1，老用户升级后自动重播一次新指引 */
export const CURRENT_COACH_TOUR_VERSION = 5
