import { useState, useEffect, useCallback } from 'react'

type MigrationComponent = 'sessions' | 'skills' | 'mcp' | 'channels' | 'chattools'

interface PathCheckResult {
  path: string
  exists: boolean
  suggested?: string
}

export interface ImportPreview {
  manifest: {
    mode: string
    version?: string
    workspaceName?: string
    sourcePlatform: string
    exportedAt: number
    components: MigrationComponent[]
    workspaces?: Array<{
      workspaceSlug: string
      workspaceName: string
    }>
  }
  agentSessionCount: number
  chatConversationCount: number
  skillNames: string[]
  hasMcp: boolean
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
  workspaces?: WorkspaceImportPreviewItem[]
  personal?: {
    available: boolean
    sections: string[]
    blobCount: number
    blobBytes: number
    missingBlobs: number
    warnings: string[]
  }
}

export interface WorkspaceImportPreviewItem {
  workspaceSlug: string
  workspaceName: string
  skillNames: string[]
  mcpServerNames: string[]
  existsLocally: boolean
  localWorkspaceId?: string
  conflictingSkills: string[]
  conflictingMcpServers: string[]
}

export interface WorkspaceImportMapping {
  sourceSlug: string
  action: 'merge' | 'create' | 'skip'
  targetWorkspaceId?: string
  newWorkspaceName?: string
}

export interface MigrationImportResult {
  success: boolean
  error?: string
  warnings?: string[]
  restored?: string[]
}

interface UseMigrationImportReturn {
  importing: boolean
  importPreview: ImportPreview | null
  pathMappings: Record<string, string | null>
  workspaceMappings: WorkspaceImportMapping[]
  conflictResolution: 'overwrite' | 'skip'
  hasConflicts: boolean
  importConfirming: boolean
  importResult: MigrationImportResult | null
  isV2: boolean
  /** 备份已加密，等待用户输入口令 */
  requiresPassphrase: boolean
  passphrase: string
  passphraseError: string | null
  setPassphrase: (value: string) => void
  submitPassphrase: () => Promise<void>
  cancelPassphrase: () => void
  handleSelectImportFile: () => Promise<void>
  handleConfirmImport: () => Promise<void>
  handlePathMapping: (originalPath: string, newValue: string | null) => void
  handleWorkspaceMapping: (sourceSlug: string, mapping: Partial<WorkspaceImportMapping>) => void
  setConflictResolution: (value: 'overwrite' | 'skip') => void
  reset: () => void
}

export function useMigrationImport(initialFilePath?: string | null): UseMigrationImportReturn {
  const [importing, setImporting] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [pathMappings, setPathMappings] = useState<Record<string, string | null>>({})
  const [workspaceMappings, setWorkspaceMappings] = useState<WorkspaceImportMapping[]>([])
  const [conflictResolution, setConflictResolution] = useState<'overwrite' | 'skip'>('overwrite')
  const [importConfirming, setImportConfirming] = useState(false)
  const [importResult, setImportResult] = useState<MigrationImportResult | null>(null)
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [passphraseError, setPassphraseError] = useState<string | null>(null)

  const isV2 = !!importPreview?.workspaces

  const hasConflicts = importPreview?.workspaces?.some((ws) => {
    const mapping = workspaceMappings.find((m) => m.sourceSlug === ws.workspaceSlug)
    if (!mapping || mapping.action !== 'merge') return false
    return (ws.conflictingSkills?.length ?? 0) > 0 || (ws.conflictingMcpServers?.length ?? 0) > 0
  }) ?? false

  const initFromPreview = useCallback((preview: ImportPreview) => {
    const initialPathMappings: Record<string, string | null> = {}
    for (const r of preview.pathCheckResults) {
      if (!r.exists) initialPathMappings[r.path] = null
    }
    setPathMappings(initialPathMappings)

    if (preview.workspaces) {
      const mappings: WorkspaceImportMapping[] = preview.workspaces.map((ws) => ({
        sourceSlug: ws.workspaceSlug,
        action: ws.existsLocally ? 'merge' : 'create',
        targetWorkspaceId: ws.localWorkspaceId,
        newWorkspaceName: ws.workspaceName,
      }))
      setWorkspaceMappings(mappings)
    } else {
      setWorkspaceMappings([])
    }

    setImportPreview(preview)
  }, [])

  const parseFile = useCallback(async (filePath: string, passphraseValue?: string) => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)
    setPassphraseError(null)

    try {
      const preview = await window.electronAPI.migrationParseImportFile(filePath, passphraseValue) as ImportPreview
      initFromPreview(preview)
      setPendingFilePath(null)
      setPassphrase('')
    } catch (err) {
      const message = err instanceof Error ? err.message : '解析文件失败'
      if (passphraseValue) {
        // 口令类错误留在口令输入阶段，方便直接重试；其他错误按普通失败展示。
        setPassphraseError(message)
      } else {
        setImportResult({ success: false, error: message })
      }
    } finally {
      setImporting(false)
    }
  }, [initFromPreview])

  const openFile = useCallback(async (filePath: string) => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)
    setPassphraseError(null)

    try {
      const info = await window.electronAPI.migrationInspectImportFile(filePath)
      if (info.encrypted) {
        setPendingFilePath(filePath)
        setPassphrase('')
        return
      }
      await parseFile(filePath)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '解析文件失败' })
    } finally {
      setImporting(false)
    }
  }, [parseFile])

  useEffect(() => {
    if (initialFilePath) {
      void openFile(initialFilePath)
    }
  }, [initialFilePath, openFile])

  const handleSelectImportFile = useCallback(async () => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)
    setPassphraseError(null)

    let filePath: string | null
    try {
      filePath = await window.electronAPI.migrationOpenFileDialog()
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '选择文件失败' })
      setImporting(false)
      return
    }
    if (!filePath) {
      setImporting(false)
      return
    }
    await openFile(filePath)
  }, [openFile])

  const submitPassphrase = useCallback(async () => {
    if (!pendingFilePath) return
    await parseFile(pendingFilePath, passphrase)
  }, [pendingFilePath, passphrase, parseFile])

  const cancelPassphrase = useCallback(() => {
    setPendingFilePath(null)
    setPassphrase('')
    setPassphraseError(null)
  }, [])

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview) return
    setImportConfirming(true)

    try {
      const result = await window.electronAPI.migrationConfirmImport({
        tempDir: importPreview.tempDir,
        manifest: importPreview.manifest,
        pathMappings,
        conflictResolution: hasConflicts ? conflictResolution : undefined,
        ...(isV2 ? { workspaceMappings } : {}),
      }) as MigrationImportResult
      setImportResult({ success: true, warnings: result.warnings, restored: result.restored })
      setImportPreview(null)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setImportConfirming(false)
    }
  }, [importPreview, pathMappings, workspaceMappings, isV2, conflictResolution, hasConflicts])

  const handlePathMapping = useCallback((originalPath: string, newValue: string | null) => {
    setPathMappings((prev) => ({ ...prev, [originalPath]: newValue }))
  }, [])

  const handleWorkspaceMapping = useCallback((sourceSlug: string, partial: Partial<WorkspaceImportMapping>) => {
    setWorkspaceMappings((prev) =>
      prev.map((m) => (m.sourceSlug === sourceSlug ? { ...m, ...partial } : m))
    )
  }, [])

  const reset = useCallback(() => {
    // 清理主进程中的临时解压目录
    if (importPreview?.tempDir) {
      window.electronAPI.migrationCancelImport(importPreview.tempDir).catch(() => {})
    }
    setImporting(false)
    setImportPreview(null)
    setPathMappings({})
    setWorkspaceMappings([])
    setConflictResolution('overwrite')
    setImportConfirming(false)
    setImportResult(null)
    setPendingFilePath(null)
    setPassphrase('')
    setPassphraseError(null)
  }, [importPreview?.tempDir])

  return {
    importing,
    importPreview,
    pathMappings,
    workspaceMappings,
    conflictResolution,
    hasConflicts,
    importConfirming,
    importResult,
    isV2,
    requiresPassphrase: pendingFilePath !== null,
    passphrase,
    passphraseError,
    setPassphrase,
    submitPassphrase,
    cancelPassphrase,
    handleSelectImportFile,
    handleConfirmImport,
    handlePathMapping,
    handleWorkspaceMapping,
    setConflictResolution,
    reset,
  }
}
