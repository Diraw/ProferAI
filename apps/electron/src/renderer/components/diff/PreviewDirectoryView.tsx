/**
 * 预览面板的目录视图
 *
 * 会话里的文件链接经常指向目录（如 `~/.profer-dev/skins/<skin-id>`）。这类路径过去只会落到
 * 「文件不存在或无法读取」，现在改为展示目录清单：子目录可继续进入，文件可直接点开预览。
 *
 * 列表数据来自主进程 `listDirectory`（只读预览策略：系统/凭据敏感位置仍拒绝），
 * 排序由主进程统一保证（目录在前、隐藏项靠后、名称本地化排序）。
 */

import * as React from 'react'
import { ArrowUp, Folder, FolderOpen, Loader2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileBaseName, getFileParentPath } from '@/lib/file-utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import type { FileEntry } from '@profer/shared'

/** 体积展示：目录不带 size，文件按 B/KB/MB/GB 取一位小数。 */
export function formatEntrySize(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
}

interface PreviewDirectoryViewProps {
  /** 初始目录（绝对路径或 `~/` 形式） */
  filePath: string
  sessionId: string
  basePaths?: string[]
}

export function PreviewDirectoryView({ filePath, sessionId, basePaths }: PreviewDirectoryViewProps): React.ReactElement {
  const openPreview = useOpenPreview()
  const [currentPath, setCurrentPath] = React.useState(filePath)
  const [entries, setEntries] = React.useState<FileEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')

  // 预览目标变化时（同一面板切换文件）回到新目录
  React.useEffect(() => {
    setCurrentPath(filePath)
  }, [filePath])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    window.electronAPI
      .listDirectory(currentPath, { sessionId, candidateBasePaths: basePaths })
      .then((items) => {
        if (cancelled) return
        setEntries(items)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntries([])
        setError(err instanceof Error ? err.message : '无法读取该目录')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [basePaths, currentPath, sessionId])

  const parentPath = getFileParentPath(currentPath)
  const currentName = getFileBaseName(currentPath) || currentPath

  const openEntry = React.useCallback(
    (entry: FileEntry): void => {
      if (entry.isDirectory) {
        setCurrentPath(entry.path)
        return
      }
      openPreview(sessionId, {
        filePath: entry.path,
        previewOnly: true,
        basePaths: basePaths?.length ? basePaths : undefined,
      })
    },
    [basePaths, openPreview, sessionId],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border/40 px-3 py-1.5">
        <button
          type="button"
          disabled={!parentPath}
          onClick={() => parentPath && setCurrentPath(parentPath)}
          title="上级目录"
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{currentName}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {loading ? '读取中' : `${entries.length} 项`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <TriangleAlert className="size-6 text-muted-foreground/60" />
            <span className="text-[13px] text-muted-foreground">{error}</span>
            <span className="break-all font-mono text-[12px] text-muted-foreground/70">{currentPath}</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">空目录</div>
        ) : (
          <ul className="py-1">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => openEntry(entry)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]',
                    'hover:bg-muted/50',
                  )}
                >
                  {entry.isDirectory ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileTypeIcon name={entry.name} isDirectory={false} size={16} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatEntrySize(entry.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!loading && !error && (
        <div className="border-t border-border/40 px-3 py-1 text-[11px] text-muted-foreground">
          点击文件打开预览，点击文件夹进入下一级
        </div>
      )}
    </div>
  )
}
