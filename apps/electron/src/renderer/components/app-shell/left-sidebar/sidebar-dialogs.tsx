/**
 * sidebar-dialogs.tsx — 侧边栏弹窗（删除/迁移/加入工作区）
 *
 * 从 LeftSidebar 抽离的四个弹窗，通过 hook 返回值（SidebarModel）读取状态，
 * collapsed / expanded 两个视图共享同一实例，避免 Radix Portal 双实例叠遮罩。
 */

import * as React from 'react'
import { MoveSessionDialog } from '@/components/agent/MoveSessionDialog'
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
import type { SidebarModel } from './use-left-sidebar'

export function SidebarDialogs({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    pendingDeleteId,
    pendingDeleteDelegatedChildCount,
    setPendingDeleteId,
    handleConfirmDelete,
    pendingDeleteWorkspaceId,
    setPendingDeleteWorkspaceId,
    deletingWorkspaceId,
    pendingDeleteWorkspace,
    handleConfirmDeleteWorkspace,
    moveTargetId,
    setMoveTargetId,
    currentWorkspaceId,
    workspaces,
    handleSessionMoved,
  } = s

  return (
    <>
      {/* 删除确认弹窗（collapsed/expanded 共享） */}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}
      >
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleConfirmDelete()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除对话</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteDelegatedChildCount > 0
                ? `删除后将无法恢复，并将同时永久删除 ${pendingDeleteDelegatedChildCount} 个协作子会话。`
                : '删除后将无法恢复，确定要删除这个对话吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 项目删除确认弹窗（会同时删除项目下的会话与工作区资源） */}
      <AlertDialog
        open={pendingDeleteWorkspaceId !== null}
        onOpenChange={(open) => {
          if (!open && !deletingWorkspaceId) setPendingDeleteWorkspaceId(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !deletingWorkspaceId) {
              e.preventDefault()
              void handleConfirmDeleteWorkspace()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{pendingDeleteWorkspace?.name ?? '该项目'}」及其绑定的所有会话、自动任务、MCP、Skills、工作区文件和本地项目目录。附加目录和附加文件只会移除引用，不会删除原始文件。删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingWorkspaceId}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deletingWorkspaceId}
              onClick={handleConfirmDeleteWorkspace}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingWorkspaceId ? '删除中...' : '删除项目'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 迁移会话对话框（collapsed/expanded 共享） */}
      <MoveSessionDialog
        open={moveTargetId !== null}
        onOpenChange={(open) => { if (!open) setMoveTargetId(null) }}
        sessionId={moveTargetId ?? ''}
        currentWorkspaceId={currentWorkspaceId ?? undefined}
        workspaces={workspaces}
        onMoved={handleSessionMoved}
      />

    </>
  )
}
