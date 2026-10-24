/**
 * FeatureTour — 首次启动的产品导览。
 *
 * 设计原则：
 *  - 一页只讲一件事，左边说人话，右边直接给「产品长什么样」的界面缩影；
 *  - 不自动翻页：节奏交给用户，键盘 →/Enter/Esc 与底部按钮都能操作；
 *  - 顶部故事条同时承担进度与跳转，关闭按钮与内容栅格同一条基线，不再内缩错位。
 */

import * as React from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { IntroFluidBackground } from './IntroFluidBackground'
import {
  AgentMock,
  ChatMock,
  MobileMock,
  PlanningMock,
  SkillsMock,
  WorkspaceMock,
} from './tour-mocks'

interface TourSlide {
  key: string
  kicker: string
  title: string
  summary: string
  example: string
  tags: string[]
  Mock: () => React.ReactElement
}

const FEATURE_TOUR_SLIDES: TourSlide[] = [
  {
    key: 'chat',
    kicker: 'CHAT',
    title: '先问清楚，\n再动手。',
    summary: '翻译、改写、查资料、想方案。不需要配置工作区，打开就能问。',
    example: '把这段话改成给客户看的正式邮件',
    tags: ['翻译', '改写', '总结', '头脑风暴'],
    Mock: ChatMock,
  },
  {
    key: 'agent',
    kicker: 'AGENT',
    title: '说清目标，\n它把事做完。',
    summary: '它会自己拆步骤、读文件、跑命令，做完再回来汇报。你只需要说清目标。',
    example: '分析 @销售.xlsx，找出下滑原因，写成报告',
    tags: ['读文件', '跑命令', '多步任务', '交付结果'],
    Mock: AgentMock,
  },
  {
    key: 'workspace',
    kicker: 'WORKSPACE',
    title: '你的文件，\n就是上下文。',
    summary: '用 @ 把文件、文件夹带进对话。改了什么、改在哪一行，都能直接对照。',
    example: '按这份模板重写 @季度总结.md',
    tags: ['@ 引用', '改动对照', '工作区边界'],
    Mock: WorkspaceMock,
  },
  {
    key: 'skills',
    kicker: 'SKILLS',
    title: '一次成功，\n次次复用。',
    summary: '把常用做法存成 Skill，下次一句话调用；MCP 接外部工具，记忆记住你的偏好。',
    example: '把刚才这套周报流程存成 Skill',
    tags: ['Skills', 'MCP 工具', '工作区记忆', '岗位预设'],
    Mock: SkillsMock,
  },
  {
    key: 'planning',
    kicker: 'AUTOMATION',
    title: '重复的事，\n自己发生。',
    summary: 'Todo 记要做的、日程排时间、定时任务到点自动执行。三块各有入口，结果写回会话。',
    example: '每周一早上 9 点整理上周进展并提醒我',
    tags: ['Todo', '日程', '定时任务'],
    Mock: PlanningMock,
  },
  {
    key: 'mobile',
    kicker: 'POCKET',
    title: '离开电脑，\n也能继续。',
    summary: '同一个任务在手机上继续，回到电脑前，结果已经在那里。',
    example: '在手机上让它继续处理这个任务',
    tags: ['随时接手', '结果同步'],
    Mock: MobileMock,
  },
]

interface FeatureTourProps {
  onNext: () => void
  onSkip: () => void
  finishLabel: string
}

export function FeatureTour({ onNext, onSkip, finishLabel }: FeatureTourProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [direction, setDirection] = React.useState<1 | -1>(1)
  const isLast = activeIndex === FEATURE_TOUR_SLIDES.length - 1
  const slide = FEATURE_TOUR_SLIDES[activeIndex]!

  const goTo = React.useCallback((nextIndex: number) => {
    if (nextIndex === activeIndex) return
    setDirection(nextIndex > activeIndex ? 1 : -1)
    setActiveIndex(nextIndex)
  }, [activeIndex])

  const next = React.useCallback(() => {
    if (isLast) {
      onNext()
      return
    }
    goTo(activeIndex + 1)
  }, [activeIndex, goTo, isLast, onNext])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // 焦点在按钮/标签上时，Enter/Space 交给控件自身，避免抢掉原生激活
      const target = event.target as HTMLElement | null
      const onControl = Boolean(target?.closest('button, [role="tab"], a, input, textarea, select'))
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if ((event.key === 'Enter' || event.key === ' ') && !onControl) {
        event.preventDefault()
        next()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onSkip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [next, onSkip])

  const progressLabel = `${String(activeIndex + 1).padStart(2, '0')} / ${String(FEATURE_TOUR_SLIDES.length).padStart(2, '0')}`

  return (
    <section
      className="relative flex h-screen w-screen overflow-hidden bg-black text-white"
      aria-label="Profer 功能导览"
    >
      <IntroFluidBackground durationMs={26000} repeat />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(100deg,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.58)_46%,rgba(0,0,0,0.14)_100%)]" />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_72%_46%,transparent_8%,rgba(0,0,0,0.28)_80%,rgba(0,0,0,0.55)_100%)]" />

      <div className="relative z-10 mx-auto flex h-full w-full max-w-[1440px] flex-col px-8 py-6 sm:px-12 lg:px-16">
        {/* 顶栏：品牌、进度、退出。左右都以同一 32px 基线居中，X 不再相对内容内缩。 */}
        <header className="flex h-8 items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] tracking-[0.3em] text-white/70">PROFER</span>
            <span className="h-3 w-px bg-white/15" aria-hidden="true" />
            <span className="text-[11px] tracking-[0.16em] text-white/35">产品导览</span>
          </div>

          <button
            type="button"
            onClick={onSkip}
            className="-mr-2.5 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            跳过导览
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </header>

        {/* 故事条：既是进度也是跳转，避免底部小圆点被忽略 */}
        <div className="mt-6 flex items-center gap-1.5" role="tablist" aria-label="导览进度">
          {FEATURE_TOUR_SLIDES.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-label={`第 ${index + 1} 页：${item.kicker}`}
              aria-selected={index === activeIndex}
              onClick={() => goTo(index)}
              className="group relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full bg-white transition-all duration-500 ease-out',
                  index < activeIndex ? 'w-full opacity-45' : index === activeIndex ? 'w-full opacity-95' : 'w-0 opacity-0',
                  'group-hover:opacity-100',
                )}
              />
            </button>
          ))}
        </div>

        <main className="flex flex-1 items-center py-4">
          <div className="grid w-full grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)] xl:gap-16">
            <div
              key={`${slide.key}-copy`}
              className={cn(
                'tour-copy max-w-xl',
                direction === 1 ? 'tour-copy-forward' : 'tour-copy-backward',
              )}
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] tracking-[0.28em] text-white/45">{slide.kicker}</span>
                <span className="h-px w-8 bg-white/20" aria-hidden="true" />
                <span className="font-mono text-[10px] tracking-[0.18em] text-white/25">{progressLabel}</span>
              </div>

              <h2 className="mt-5 whitespace-pre-line text-[clamp(2.5rem,4vw,3.9rem)] font-semibold leading-[1.02] tracking-[-0.03em] text-white">
                {slide.title}
              </h2>

              <p className="mt-5 max-w-[520px] text-[17px] leading-relaxed text-white/55">{slide.summary}</p>

              <div className="mt-7 flex items-center gap-2.5 rounded-xl border border-white/[0.09] bg-white/[0.035] px-3.5 py-2.5 backdrop-blur-sm">
                <ArrowUpRight className="size-3.5 shrink-0 text-white/35" aria-hidden="true" />
                <span className="font-mono text-[10px] tracking-[0.14em] text-white/30">试试这样说</span>
                <span className="truncate text-[13px] text-white/80">“{slide.example}”</span>
              </div>

              <ul className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-white/35">
                {slide.tags.map((tag, index) => (
                  <li key={tag} className="flex items-center gap-3">
                    {index > 0 && <span className="size-0.5 rounded-full bg-white/25" aria-hidden="true" />}
                    {tag}
                  </li>
                ))}
              </ul>
            </div>

            <div
              key={`${slide.key}-mock`}
              className={cn(
                'tour-mock hidden justify-end lg:flex',
                direction === 1 ? 'tour-mock-forward' : 'tour-mock-backward',
              )}
            >
              <div className="relative w-full max-w-[560px]">
                <div
                  className="pointer-events-none absolute -inset-10 rounded-[3rem] bg-[radial-gradient(circle_at_60%_45%,rgba(255,255,255,0.09),transparent_70%)]"
                  aria-hidden="true"
                />
                <div className="relative -rotate-[0.35deg]">
                  <slide.Mock />
                </div>
              </div>
            </div>
          </div>
        </main>

        <footer className="flex h-14 items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.18em] text-white/25">
            {activeIndex + 1} / {FEATURE_TOUR_SLIDES.length}
          </span>

          <button
            type="button"
            onClick={next}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-white pl-5 pr-4 text-[13px] font-medium text-neutral-900 transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            {isLast ? finishLabel : '继续'}
            {isLast ? <Check className="size-4" aria-hidden="true" /> : <ArrowRight className="size-4" aria-hidden="true" />}
          </button>
        </footer>
      </div>
    </section>
  )
}

export { FEATURE_TOUR_SLIDES }
