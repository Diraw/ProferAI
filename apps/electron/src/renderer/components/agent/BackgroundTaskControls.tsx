import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { FileOutput, Loader2 } from 'lucide-react'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/agent-atoms'
import { ActiveTasksBar } from './ActiveTasksBar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { Dialog, DialogContent, DialogTitle } from '@profer/ui/primitives/dialog'

interface BackgroundTaskControlsProps {
  sessionId: string
}

export function BackgroundTaskControls({ sessionId }: BackgroundTaskControlsProps): React.ReactElement | null {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))
  const [pendingStop, setPendingStop] = React.useState<BackgroundTask | null>(null)
  const [stopping, setStopping] = React.useState(false)
  const [outputTask, setOutputTask] = React.useState<BackgroundTask | null>(null)
  const [output, setOutput] = React.useState<string | null>(null)
  const [outputLoading, setOutputLoading] = React.useState(false)
  const [outputError, setOutputError] = React.useState<string | null>(null)

  const readOutput = React.useCallback(async (task: BackgroundTask) => {
    setOutputTask(task)
    setOutput(task.output ?? null)
    setOutputError(null)
    setOutputLoading(true)
    try {
      const result = await window.electronAPI.getTaskOutput({ sessionId, taskId: task.id })
      setOutput(result.output)
      setTasks((previous) => previous.map((item) => item.id === task.id ? { ...item, output: result.output } : item))
      if (result.status && result.status !== 'running') {
        toast.info(`任务状态：${result.status}`, { description: result.summary })
      }
    } catch (error) {
      setOutputError(error instanceof Error ? error.message : '读取任务输出失败')
    } finally {
      setOutputLoading(false)
    }
  }, [sessionId, setTasks])

  const stopTask = React.useCallback(async () => {
    if (!pendingStop) return
    setStopping(true)
    try {
      await window.electronAPI.stopTask({ sessionId, taskId: pendingStop.id, type: pendingStop.type })
      setTasks((previous) => previous.filter((task) => task.id !== pendingStop.id))
      toast.success('后台任务已停止')
      setPendingStop(null)
    } catch (error) {
      toast.error('停止后台任务失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setStopping(false)
    }
  }, [pendingStop, sessionId, setTasks])

  const handleTaskClick = React.useCallback((toolUseId: string) => {
    const target = document.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  if (tasks.length === 0) return null

  return (
    <>
      <ActiveTasksBar
        tasks={tasks}
        onTaskClick={handleTaskClick}
        onTaskStop={async (task) => {
          setPendingStop(task)
        }}
        onTaskOutput={readOutput}
      />

      <AlertDialog open={pendingStop !== null} onOpenChange={(open) => !open && !stopping && setPendingStop(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停止后台任务？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingStop?.intent || `将请求 Runtime 停止 ${pendingStop?.type === 'shell' ? 'Shell' : 'Agent'} 任务 ${pendingStop?.id ?? ''}。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={stopping} onClick={(event) => { event.preventDefault(); void stopTask() }}>
              {stopping && <Loader2 className="mr-2 size-4 animate-spin" />}
              停止任务
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={outputTask !== null} onOpenChange={(open) => { if (!open) setOutputTask(null) }}>
        <DialogContent className="flex max-h-[80vh] w-[min(900px,92vw)] flex-col gap-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileOutput className="size-4" />
            {outputTask?.intent || `${outputTask?.type === 'shell' ? 'Shell' : 'Agent'} 后台任务输出`}
          </DialogTitle>
          {outputLoading && <div aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在读取任务输出</div>}
          {outputError && <p role="alert" className="text-sm text-destructive">{outputError}</p>}
          {!outputLoading && !outputError && (
            <pre className="max-h-[60vh] min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground/80">
              {output || '暂无可用输出'}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
