import type { PermissionPort, RuntimeCanUseTool, RuntimeCanUseToolOptions, RuntimePermissionResult } from '@profer/agent-runtime'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { createPlanModeGatedCanUseTool, getAgentRuntimePlanMode } from './agent-runtime-plan-mode'

function toRuntimeCanUseToolOptions(options: Parameters<ReturnType<typeof permissionService.createCanUseTool>>[2]): RuntimeCanUseToolOptions {
  return {
    signal: options.signal,
    suggestions: options.suggestions,
    blockedPath: options.blockedPath,
    decisionReason: options.decisionReason,
    decisionReasonType: options.decisionReasonType,
    classifierApprovable: options.classifierApprovable,
    toolUseID: options.toolUseID,
    agentID: options.agentID,
    title: options.title,
    displayName: options.displayName,
    description: options.description,
  }
}

function toRuntimePermissionResult(result: Awaited<ReturnType<ReturnType<typeof permissionService.createCanUseTool>>>): RuntimePermissionResult {
  return {
    ...result,
    ...(result.behavior === 'allow' && result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}),
  }
}


export function createElectronPermissionPort(options?: Pick<PermissionPort, 'canUseTool'>): PermissionPort {
  return {
    createCanUseTool(input) {
      const callback = permissionService.createCanUseTool(
        input.sessionId,
        input.sendPermissionRequest,
        input.handleAskUser as Parameters<typeof permissionService.createCanUseTool>[2],
        input.sendAskUserRequest,
      )
      const inner: RuntimeCanUseTool = async (toolName, toolInput, options) => toRuntimePermissionResult(await callback(toolName, toolInput, toRuntimeCanUseToolOptions(options) as Parameters<typeof callback>[2]))
      // 计划模式责任方：入口注册了本轮控制器时，EnterPlanMode / ExitPlanMode 与 plan 只读工具面
      // 必须在进入通用权限判定之前拦截；未注册时保持既有行为（不新增隐藏默认值）。
      const planMode = getAgentRuntimePlanMode(input.sessionId)
      if (!planMode) return inner
      return createPlanModeGatedCanUseTool({
        controller: planMode,
        inner,
        requestExitPlanApproval: ({ toolInput, signal }) =>
          exitPlanService.handleExitPlanMode(input.sessionId, toolInput, signal, request => planMode.emitExitPlanRequest(request)) as Promise<RuntimePermissionResult>,
      })
    },
    handleAskUserQuestion(input) {
      return askUserService.handleAskUserQuestion(input.sessionId, input.toolInput, input.signal, input.sendToRenderer)
    },
    handleExitPlanMode(input) {
      return exitPlanService.handleExitPlanMode(input.sessionId, input.toolInput, input.signal, input.sendToRenderer) as Promise<RuntimePermissionResult>
    },
    clearSessionPending(sessionId) {
      // turn 结束只清权限与计划审批；AskUser 由用户交互或会话删除结束。
      permissionService.clearSessionPending(sessionId)
      exitPlanService.clearSessionPending(sessionId)
    },
    clearSessionWhitelist(sessionId) {
      permissionService.clearSessionWhitelist(sessionId)
    },
    ...(options?.canUseTool ? { canUseTool: options.canUseTool } : {}),
  }
}
