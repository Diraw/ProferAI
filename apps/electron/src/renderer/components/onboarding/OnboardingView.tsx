/**
 * Onboarding 视图组件
 *
 * 首次启动时显示的全屏欢迎界面。
 *
 * 流程：
 *  Step 0：开屏水波纹动画（Profer 从水面具现，自动进入下一步）
 *  Step 1：欢迎
 *  Step 2：核心功能导览（FeatureTour，6 页）
 *  Step 3：Windows 环境检测（仅 Windows，其他平台自动跳过）
 *  Step 4：迁移数据指引（从其他设备 / 其他用户导入配置）
 *
 * 视觉：欢迎、导览、迁移共用同一块深色舞台（液态背景 + 统一 1440px 栅格），
 * 顶栏、进度、关闭按钮在所有步骤里保持同一条基线与同样的内缩，避免「X 飘在角落」。
 */

import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowRight,
  Check,
  ChevronRight,
  FileArchive,
  HardDriveDownload,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EnvironmentCheckPanel } from '@/components/environment/EnvironmentCheckPanel'
import { isShellEnvironmentOkAtom } from '@/atoms/environment'
import { detectIsWindows } from '@profer/ui'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { IntroWaterRipple } from './IntroWaterRipple'
import { IntroFluidBackground } from './IntroFluidBackground'
import { FeatureTour } from './FeatureTour'
import { ChatMock } from './tour-mocks'

type OnboardingStep = 'intro' | 'welcome' | 'featureTour' | 'environment' | 'migration'

interface OnboardingViewProps {
  onComplete: (openTutorial?: boolean) => void
  /** 供主界面测试入口复用首次引导页；默认仍从开屏开始。 */
  initialStep?: OnboardingStep
  /** 测试重放完成时不写入用户的首次 onboarding 状态。 */
  persistCompletion?: boolean
}

const MIGRATION_ITEMS = ['会话与工作区文件', 'Skills、MCP 与预设', '模型渠道与偏好设置']

export function OnboardingView({
  onComplete,
  initialStep = 'intro',
  persistCompletion = true,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const isWindows = useMemo(() => detectIsWindows(), [])
  const shellOk = useAtomValue(isShellEnvironmentOkAtom)
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)

  const handleFinish = async (openTutorial?: boolean) => {
    if (persistCompletion) {
      const settings = await window.electronAPI.getSettings()
      if (!settings.onboardingCompleted) {
        try {
          const events = await window.electronAPI.listCalendarEvents()
          const demoTitle = '随便安排的一件事'
          if (!events.some((event) => event.title === demoTitle)) {
            const today = new Date()
            today.setHours(0, 0, 0, 0)
            await window.electronAPI.createCalendarEvent({
              title: demoTitle,
              notes: '首次引导中的示例日程，没有实际安排。',
              startAt: today.getTime(),
              allDay: true,
            })
          }
        } catch (error) {
          console.error('[Onboarding] 创建示例日程失败:', error)
        }
      }
      await window.electronAPI.updateSettings({ onboardingCompleted: true })
    }
    onComplete(openTutorial)
  }

  const handleNextFromWelcome = () => {
    setStep('featureTour')
  }

  const handleNextFromFeatureTour = () => {
    if (isWindows) {
      setStep('environment')
    } else {
      setStep('migration')
    }
  }

  const handleNextFromEnvironment = () => {
    setStep('migration')
  }

  const handleOpenMigration = () => {
    setMigrationImportDialogOpen(true)
  }

  if (step === 'intro') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-black">
        <IntroWaterRipple
          onDone={() => {
            setStep('welcome')
          }}
        />
      </div>
    )
  }

  if (step === 'featureTour') {
    return (
      <FeatureTour
        finishLabel={isWindows ? '下一步：环境检测' : '下一步：导入数据'}
        onNext={handleNextFromFeatureTour}
        onSkip={handleNextFromFeatureTour}
      />
    )
  }

  const totalSteps = isWindows ? 3 : 2
  const stepIndex = step === 'welcome' ? 1 : step === 'environment' ? 2 : isWindows ? 3 : 2
  const stepLabel = step === 'welcome' ? '欢迎' : step === 'environment' ? '环境检查' : '导入数据'

  return (
    <OnboardingStage
      stepIndex={stepIndex}
      totalSteps={totalSteps}
      stepLabel={stepLabel}
      onSkip={() => handleFinish()}
      fluid={step === 'welcome'}
    >
      {step === 'welcome' && (
        <div className="grid w-full grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.94fr)] xl:gap-16">
          <div className="tour-copy-forward max-w-xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[10px] tracking-[0.16em] text-white/45">
              <span className="size-1.5 rounded-full bg-emerald-400/80" aria-hidden="true" />
              桌面 AI · 通用 AGENT
            </span>

            <h1 className="mt-6 text-[clamp(2.6rem,4.2vw,4rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-white">
              把想法交给它，
              <br />
              把结果拿回来。
            </h1>

            <p className="mt-6 max-w-[520px] text-[17px] leading-relaxed text-white/55">
              Profer 能聊天，也能读你的文件、跑命令、按计划把事做完。先花一分钟，看看它到底能帮你做什么。
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleNextFromWelcome}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-white pl-5 pr-4 text-[14px] font-medium text-neutral-900 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                开始导览
                <ArrowRight className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => handleFinish()}
                className="inline-flex h-11 items-center rounded-full px-4 text-[13px] text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white/80"
              >
                跳过，直接使用
              </button>
            </div>

            <p className="mt-5 text-[11px] text-white/30">
              导览随时可以从顶栏的指南针按钮重播，不用怕错过。
            </p>
          </div>

          <div className="relative hidden justify-end lg:flex">
            <div className="relative w-full max-w-[520px]">
              <div
                className="pointer-events-none absolute -inset-10 rounded-[3rem] bg-[radial-gradient(circle_at_60%_45%,rgba(255,255,255,0.10),transparent_70%)]"
                aria-hidden="true"
              />
              <div className="relative -rotate-[0.4deg]">
                <ChatMock />
              </div>
              <div className="absolute -bottom-9 left-4 flex items-center gap-2 rounded-xl border border-white/10 bg-[#101012]/95 px-3 py-2 text-[11px] text-white/60 shadow-xl">
                <Check className="size-3.5 text-emerald-300/80" aria-hidden="true" />
                已完成 · 销售下滑分析.md
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'environment' && isWindows && (
        <div className="mx-auto w-full max-w-2xl">
          <p className="font-mono text-[10px] tracking-[0.24em] text-white/35">WINDOWS / ENVIRONMENT</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-[-0.02em]">先检查一下环境</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-white/45">
            Profer 在 Windows 上需要 Git Bash 或 WSL 才能执行命令。检测不通过也可以先用 Chat。
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-card p-5 text-card-foreground shadow-2xl">
            <EnvironmentCheckPanel autoDetectOnMount />
          </div>

          <div className="mt-6 flex items-center justify-end">
            <button
              type="button"
              onClick={handleNextFromEnvironment}
              className={cn(
                'inline-flex h-10 items-center gap-2 rounded-full px-5 text-[13px] font-medium transition-transform hover:scale-[1.02] active:scale-[0.99]',
                shellOk ? 'bg-white text-neutral-900' : 'border border-white/15 text-white/75 hover:bg-white/[0.07]',
              )}
            >
              {shellOk ? '下一步：导入数据' : '跳过环境检测，继续'}
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {step === 'migration' && (
        <div className="grid w-full grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.06fr)_minmax(0,0.9fr)] xl:gap-20">
          <div className="tour-copy-forward max-w-xl">
            <p className="font-mono text-[10px] tracking-[0.24em] text-white/35">FINAL / IMPORT</p>
            <h2 className="mt-4 text-[clamp(2.2rem,3.4vw,3.25rem)] font-semibold leading-[1.08] tracking-[-0.03em]">
              把旧环境
              <br />
              一起带过来。
            </h2>
            <p className="mt-4 max-w-[480px] text-[15px] leading-relaxed text-white/50">
              自己或同事已经在用 Profer？导入备份，会话、Skills、模型渠道和偏好设置都能接着用。
            </p>

            <div className="mt-7 space-y-2.5">
              <MigrationOption
                icon={<HardDriveDownload className="size-4" aria-hidden="true" />}
                title="从自己的其他设备迁移"
                hint="在原设备导出 .profer-backup，双击即可导入"
                onClick={handleOpenMigration}
              />
              <MigrationOption
                icon={<Users className="size-4" aria-hidden="true" />}
                title="导入同事的配置"
                hint="使用对方导出的 .profer-share 文件"
                onClick={handleOpenMigration}
              />
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => handleFinish()}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-white pl-5 pr-4 text-[14px] font-medium text-neutral-900 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                开始使用 Profer
                <ArrowRight className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => handleFinish()}
                className="inline-flex h-11 items-center rounded-full px-4 text-[13px] text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white/80"
              >
                先空着，之后在设置里导入
              </button>
            </div>
          </div>

          <div className="hidden justify-end lg:flex">
            <div className="relative w-full max-w-[440px]">
              <div
                className="pointer-events-none absolute -inset-8 rounded-[2.5rem] bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.08),transparent_70%)]"
                aria-hidden="true"
              />
              <div className="relative rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5 backdrop-blur-xl">
                <p className="font-mono text-[10px] tracking-[0.2em] text-white/30">IMPORT</p>
                <div className="mt-4 rounded-xl border border-dashed border-white/15 px-4 py-7 text-center">
                  <FileArchive className="mx-auto size-6 text-white/35" aria-hidden="true" />
                  <p className="mt-2.5 text-[12px] text-white/55">拖入 .profer-backup 或 .profer-share</p>
                  <p className="mt-1 text-[10px] text-white/30">导入前会先校验文件完整性</p>
                </div>
                <ul className="mt-4 space-y-2">
                  {MIGRATION_ITEMS.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-[11px] text-white/45">
                      <Check className="size-3 text-white/30" aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </OnboardingStage>
  )
}

/** 欢迎 / 环境 / 迁移共用的深色舞台与顶栏。 */
function OnboardingStage({
  stepIndex,
  totalSteps,
  stepLabel,
  onSkip,
  fluid,
  children,
}: {
  stepIndex: number
  totalSteps: number
  stepLabel: string
  onSkip: () => void
  fluid?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-[#08080a] text-white">
      {fluid ? (
        <>
          <IntroFluidBackground durationMs={26000} repeat fadeOut={false} />
          <div className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(100deg,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.58)_46%,rgba(0,0,0,0.14)_100%)]" />
          <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_72%_46%,transparent_8%,rgba(0,0,0,0.28)_80%,rgba(0,0,0,0.55)_100%)]" />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_30%,rgba(255,255,255,0.05),transparent_60%)]" />
      )}

      <div className="relative z-10 mx-auto flex h-full w-full max-w-[1440px] flex-col px-8 py-6 sm:px-12 lg:px-16">
        <header className="flex h-8 items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] tracking-[0.3em] text-white/70">PROFER</span>
            <span className="h-3 w-px bg-white/15" aria-hidden="true" />
            <span className="text-[11px] tracking-[0.16em] text-white/35">{stepLabel}</span>
          </div>

          <button
            type="button"
            onClick={onSkip}
            className="-mr-2.5 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            跳过设置
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="mt-6 flex items-center gap-2" aria-hidden="true">
          {Array.from({ length: totalSteps }, (_, index) => (
            <span
              key={index}
              className={cn(
                'h-[3px] flex-1 rounded-full transition-colors duration-300',
                index < stepIndex ? 'bg-white/45' : index === stepIndex ? 'bg-white' : 'bg-white/[0.14]',
              )}
            />
          ))}
          <span className="ml-2 font-mono text-[10px] tracking-[0.16em] text-white/30">
            {stepIndex} / {totalSteps}
          </span>
        </div>

        <main className="flex flex-1 items-center py-6">{children}</main>
      </div>
    </div>
  )
}

function MigrationOption({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: ReactNode
  title: string
  hint: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-3.5 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.06]"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.07] text-white/65">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-white/85">{title}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-white/35">{hint}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-white/25 transition-colors group-hover:text-white/60" aria-hidden="true" />
    </button>
  )
}
