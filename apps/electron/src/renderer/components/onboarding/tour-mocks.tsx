/**
 * tour-mocks — 首次引导里用真实 DOM 画的「产品界面缩影」。
 *
 * 为什么不用截图：截图会随主题/版本过期，也看不清重点；这里每个 mock 只保留
 * 一个信息点，用界面语言讲功能，尺寸固定在 460×360 左右，右侧栏在窄窗口可整体隐藏。
 */

import * as React from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  FileText,
  FolderClosed,
  Loader2,
  MessageSquare,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  ToggleRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** 窗口外壳：统一圆角、描边和标题条，让 6 个 mock 看起来是同一个产品。 */
function MockShell({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        'relative w-full max-w-[520px] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0a0a0b]/90 shadow-[0_50px_120px_-40px_rgba(0,0,0,0.95)] backdrop-blur-xl',
        className,
      )}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/10" />
        <span className="size-2 rounded-full bg-white/10" />
        <span className="ml-2 truncate font-mono text-[10px] tracking-[0.18em] text-white/35">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Bubble({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'solid' }): React.ReactElement {
  return (
    <div
      className={cn(
        'max-w-[86%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed',
        tone === 'solid' ? 'rounded-br-md bg-white text-neutral-900' : 'rounded-bl-md bg-white/[0.07] text-white/80',
      )}
    >
      {children}
    </div>
  )
}

/** 1. Chat：一问一答，突出「不用配置，打开就问」。 */
export function ChatMock(): React.ReactElement {
  return (
    <MockShell label="CHAT">
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-end">
          <Bubble tone="solid">把这段话改成给客户看的正式邮件</Bubble>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] text-white/70">
            <Sparkles className="size-3" />
          </span>
          <Bubble>
            好的。我保留了事实，把语气调整为对客户的书面表达，并补了一句明确的下一步：
            <span className="mt-1.5 block text-white/55">「如您方便，本周三前回复即可，我们会同步排期。」</span>
          </Bubble>
        </div>
        <div className="mt-1 flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[11px] text-white/35">
          <Paperclip className="size-3.5" />
          继续追问，或粘贴一段新的内容
          <span className="ml-auto flex items-center gap-1.5">
            <Mic className="size-3.5" />
            <ArrowUpRight className="size-3.5" />
          </span>
        </div>
      </div>
    </MockShell>
  )
}

const AGENT_STEPS = [
  { label: '读取 销售.xlsx', state: 'done' as const },
  { label: '汇总 3 个季度、12 个区域', state: 'done' as const },
  { label: '找出下滑原因并写成报告', state: 'running' as const },
]

/** 2. Agent：多步执行 + 结果落盘，突出「会动手」。 */
export function AgentMock(): React.ReactElement {
  return (
    <MockShell label="AGENT">
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[12px] text-white/75">
        <span className="grid size-5 place-items-center rounded-full bg-white/10 text-[10px]">你</span>
        分析 <span className="rounded bg-white/10 px-1 font-mono text-[11px] text-white/80">@销售.xlsx</span>，找出下滑原因
      </div>

      <div className="mt-4 space-y-2.5">
        {AGENT_STEPS.map((step) => (
          <div key={step.label} className="flex items-center gap-2.5 text-[12px]">
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full border',
                step.state === 'done'
                  ? 'border-white/15 bg-white/10 text-white/70'
                  : 'border-white/20 bg-white text-neutral-900',
              )}
            >
              {step.state === 'done' ? <Check className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
            </span>
            <span className={step.state === 'done' ? 'text-white/45 line-through decoration-white/20' : 'text-white/85'}>
              {step.label}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-white/[0.09] bg-white/[0.04] p-3">
        <div className="flex items-center gap-2 text-[12px] text-white/85">
          <FileText className="size-4 text-white/60" />
          销售下滑分析.md
          <span className="ml-auto rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-300">已生成</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/45">12 条结论 · 3 张图表 · 已重新读取文件确认内容</p>
      </div>
    </MockShell>
  )
}

const WORKSPACE_FILES = [
  { name: '销售.xlsx', icon: FileSpreadsheet, active: true },
  { name: '季度总结.md', icon: FileText },
  { name: 'assets', icon: FolderClosed },
]

/** 3. 工作区：文件树 + @ 引用，突出「文件就是上下文」。 */
export function WorkspaceMock(): React.ReactElement {
  return (
    <MockShell label="WORKSPACE">
      <div className="flex gap-3">
        <div className="w-[42%] space-y-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
          <p className="px-1 pb-1 font-mono text-[9px] tracking-[0.16em] text-white/30">项目 / 2026 Q3</p>
          {WORKSPACE_FILES.map((file) => (
            <div
              key={file.name}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]',
                file.active ? 'bg-white/[0.09] text-white/90' : 'text-white/45',
              )}
            >
              <file.icon className="size-3.5" />
              <span className="truncate">{file.name}</span>
            </div>
          ))}
        </div>

        <div className="relative min-h-[190px] flex-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <p className="text-[10px] text-white/30">季度总结.md</p>
          <div className="mt-2 space-y-1.5">
            <div className="h-1.5 w-4/5 rounded-full bg-white/15" />
            <div className="h-1.5 w-full rounded-full bg-white/[0.09]" />
            <div className="h-1.5 w-3/5 rounded-full bg-white/[0.09]" />
          </div>
          <div className="absolute inset-x-3 bottom-3 rounded-lg border border-white/15 bg-[#141416] p-2 shadow-xl">
            <div className="flex items-center gap-1.5 text-[11px] text-white/70">
              <span className="grid size-4 place-items-center rounded bg-white/10 font-mono text-[10px]">@</span>
              引用工作区文件
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-[10px] text-white/55">
              <FileSpreadsheet className="size-3" />
              销售.xlsx
            </div>
          </div>
        </div>
      </div>
    </MockShell>
  )
}

const SKILLS = [
  { name: '周报生成器', desc: '按模板汇总本周进展', on: true },
  { name: '会议纪要 → 行动项', desc: '提取负责人和截止时间', on: true },
  { name: '客户邮件润色', desc: '正式、克制、不夸大', on: false },
]

/** 4. Skills：可复用的能力卡片，突出「一次写好，反复调用」。 */
export function SkillsMock(): React.ReactElement {
  return (
    <MockShell label="SKILLS">
      <div className="space-y-2">
        {SKILLS.map((skill) => (
          <div
            key={skill.name}
            className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-white/[0.07] text-white/60">
              <Sparkles className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] text-white/85">{skill.name}</p>
              <p className="truncate text-[10px] text-white/35">{skill.desc}</p>
            </div>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[9px]',
                skill.on ? 'bg-white/90 text-neutral-900' : 'bg-white/[0.06] text-white/40',
              )}
            >
              {skill.on ? '已启用' : '未启用'}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-[11px] text-white/40">
          <Plus className="size-3.5" />
          把刚才那套流程存成 Skill
        </div>
      </div>
    </MockShell>
  )
}

/** 5. 规划与自动化：日程 + 定时任务，突出「到点自己发生」。 */
export function PlanningMock(): React.ReactElement {
  const days = ['一', '二', '三', '四', '五', '六', '日']
  return (
    <MockShell label="PLANNING">
      <div className="flex items-center justify-between text-[11px] text-white/35">
        <span>10 月 20 日 — 26 日</span>
        <span className="flex items-center gap-1 text-white/60">
          今天
          <ChevronRight className="size-3" />
        </span>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {days.map((day, index) => (
          <div
            key={day}
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg py-1.5 text-[10px]',
              index === 4 ? 'bg-white text-neutral-900' : 'text-white/45',
            )}
          >
            {day}
            <span className={cn('size-1 rounded-full', index === 4 ? 'bg-neutral-900' : 'bg-white/20')} />
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.05] px-2.5 py-2 text-[11px] text-white/75">
          <span className="size-3 rounded border border-white/30" />
          整理上周项目进展
          <span className="ml-auto font-mono text-[9px] text-white/30">09:00</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[11px] text-white/45">
          <span className="size-3 rounded border border-white/15" />
          给设计稿提反馈
          <span className="ml-auto font-mono text-[9px] text-white/25">14:30</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.04] px-3 py-2.5">
        <Clock3 className="size-3.5 text-white/50" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-white/80">每周一 09:00 · 自动运行</p>
          <p className="text-[10px] text-white/35">结果写回会话，并推送提醒</p>
        </div>
        <ToggleRight className="size-4 text-emerald-300/80" />
      </div>
    </MockShell>
  )
}

/** 6. 手机：同一任务在手机上继续。 */
export function MobileMock(): React.ReactElement {
  return (
    <div className="relative flex w-full max-w-[520px] items-center justify-center" aria-hidden="true">
      <div className="absolute inset-0 rounded-[3rem] bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.09),transparent_68%)]" />
      <div className="relative w-[320px] rounded-[2.6rem] border border-white/15 bg-[#0a0a0b] p-2.5 shadow-[0_50px_120px_-40px_rgba(0,0,0,0.95)]">
        <div className="relative overflow-hidden rounded-[2rem] border border-white/[0.06] bg-[#0d0d0f]">
          <div className="mx-auto mt-2.5 h-1 w-14 rounded-full bg-white/15" />
          <div className="px-4 pb-5 pt-4">
            <p className="text-center font-mono text-[10px] tracking-[0.2em] text-white/30">PROFER POCKET</p>
            <div className="mt-5 space-y-2.5">
              <Bubble>分析完销售表，报告放在电脑的工作区了</Bubble>
              <Bubble tone="solid">好，把结论发我一份</Bubble>
            </div>
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-[11px] text-white/40">
              <MessageSquare className="size-3.5" />
              继续这个任务
              <span className="ml-auto size-1.5 rounded-full bg-emerald-400/80" />
            </div>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-8 left-1/2 hidden -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-xl border border-white/10 bg-[#101012]/95 px-3 py-2 text-[11px] text-white/55 shadow-xl sm:flex">
        <Check className="size-3.5 text-emerald-300/80" />
        结果已同步到电脑
      </div>
    </div>
  )
}
