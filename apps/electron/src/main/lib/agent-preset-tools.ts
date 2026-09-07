import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_PRESET_SUPPRESS_KEYS,
  AGENT_PRESET_TOOL_GROUPS,
} from '@profer/shared'
import type { AgentPresetCreateInput, AgentPresetUpdateInput } from '@profer/shared'
import { getDefaultPresetId, listAgentPresets } from './agent-preset-manager'
import {
  copyWorkspacePresetFromAgent,
  createWorkspacePresetFromAgent,
  proposeAgentPresetUpdateFromAgent,
  proposeAgentPresetDefaultFromAgent,
  commitPendingAgentPresetChangeFromAgent,
  summarizeAgentPreset,
  switchSessionPresetFromAgent,
  type AgentPresetMutationOperation,
  type AgentPresetOperationSource,
  type PendingPresetChange,
} from './agent-preset-operations'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function jsonError(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  }
}

function resolveSessionWorkspaceSlug(sessionId: string): string | undefined {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.workspaceId) return undefined
  return getAgentWorkspace(meta.workspaceId)?.slug
}

export interface AgentPresetToolContext {
  sessionId: string
  workspaceSlug?: string
  source?: AgentPresetOperationSource
  allowedOperations?: readonly AgentPresetMutationOperation[]
  currentPresetReference?: import('@profer/shared').PresetReference
  userMessage?: string
  pendingChange?: PendingPresetChange
}

type ZodModule = typeof import('zod')

function buildPresetSchemas(z: ZodModule['z']) {
  return {
    create: {
      name: z.string().trim().min(1).describe('预设名称'),
      description: z.string().default('').describe('一句话描述'),
      promptSections: z.array(z.string()).optional().describe('追加到系统提示词的专属段落'),
      suppressPromptSections: z.array(z.enum(AGENT_PRESET_SUPPRESS_KEYS)).optional().describe('隐藏的内置提示词段'),
      disabledToolGroups: z.array(z.enum(AGENT_PRESET_TOOL_GROUPS)).optional().describe('禁用的产品内置工具组'),
      disabledTools: z.array(z.string()).optional().describe('禁用的单个产品内置工具短名'),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional().describe('推理强度；省略跟随默认'),
      permissionMode: z.enum(['auto', 'bypassPermissions', 'plan']).optional().describe('权限模式；省略跟随默认'),
      skillSlugs: z.array(z.string()).optional().describe('Skill 白名单；省略表示不裁剪'),
      mcpServerNames: z.array(z.string()).optional().describe('工作区 MCP 白名单；省略表示不裁剪'),
      allowSubagents: z.boolean().optional().describe('是否允许委派子 Agent；省略跟随默认'),
      basePresetId: z.enum(['standard', 'code', 'minimal']).optional().describe('派生基座；省略表示独立预设'),
    },
    copy: {
      fromId: z.string().trim().min(1).describe('源预设 ID；应先从 preset_list 的 presetReference 读取'),
      fromScope: z.enum(['builtin-meta', 'user-global', 'workspace']).describe('源预设作用域；应与 preset_list 返回值一致'),
      name: z.string().trim().min(1).optional().describe('副本名称；省略自动添加“副本”后缀'),
    },
    switch: {
      targetId: z.string().trim().min(1).describe('目标预设 ID；应先从 preset_list 的 presetReference 读取'),
      targetScope: z.enum(['builtin-meta', 'user-global', 'workspace']).describe('目标预设作用域；应与 preset_list 返回值一致'),
    },
    update: {
      targetId: z.string().trim().min(1).describe('目标工作区预设 ID；应先从 preset_list 的 presetReference 读取'),
      targetScope: z.literal('workspace').describe('只能更新当前工作区自定义预设'),
      updates: z.record(z.string(), z.unknown()).describe('拟更新字段；提交前会由主进程重新校验并冻结此对象'),
    },
    default: {
      targetId: z.string().trim().min(1).describe('目标预设 ID；应先从 preset_list 的 presetReference 读取'),
      targetScope: z.enum(['builtin-meta', 'user-global', 'workspace']).describe('目标预设作用域；应与 preset_list 返回值一致'),
    },
    commit: {},

  }
}

function resolveWorkspaceSlug(ctx: AgentPresetToolContext): string | undefined {
  return ctx.workspaceSlug ?? resolveSessionWorkspaceSlug(ctx.sessionId)
}

export async function injectAgentPresetMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: AgentPresetToolContext,
): Promise<void> {
  const workspaceSlug = resolveWorkspaceSlug(ctx)
  const source = ctx.source ?? 'user'
  const allowedOperations = ctx.allowedOperations ?? []
  let z: ZodModule['z']
  try {
    ({ z } = await import('zod') as ZodModule)
  } catch {
    z = require('zod').z
  }
  const schemas = buildPresetSchemas(z)

  const listTool = sdk.tool(
    'preset_list',
    '列出当前工作区可用的全部 Agent 预设，并标注默认预设。',
    {},
    async () => {
      const presets = listAgentPresets(workspaceSlug)
      const defaultId = getDefaultPresetId(workspaceSlug)
      return jsonResult({
        defaultPresetId: defaultId,
        presets: presets.map((preset) => summarizeAgentPreset(preset, defaultId)),
      })
    },
  )
  // Claude SDK 的 server tools 契约本身使用 SdkMcpToolDefinition<any>[]，
  // 这里需要承载 create/copy 两种不同 Zod shape，不能使用默认空 shape 泛型。
  const mutationTools: SdkMcpToolDefinition<any>[] = []

  if (source === 'user' && workspaceSlug && allowedOperations.includes('create')) {
    mutationTools.push(
      sdk.tool(
        'preset_create',
        '仅当用户明确要求创建预设或把当前工作方式固化为预设时使用。只创建当前工作区自定义预设，不切换当前会话，不修改默认预设。',
        schemas.create,
        async (args) => {
          try {
            return jsonResult(createWorkspacePresetFromAgent(
              { sessionId: ctx.sessionId, workspaceSlug, source, allowedOperations, userMessage: ctx.userMessage },
              args as AgentPresetCreateInput,
            ))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  if (source === 'user' && workspaceSlug && allowedOperations.includes('copy')) {
    mutationTools.push(
      sdk.tool(
        'preset_copy',
        '仅当用户明确要求复制预设时使用。复制为当前工作区自定义预设，不切换当前会话，不修改默认预设。',
        schemas.copy,
        async (args) => {
          try {
            return jsonResult(copyWorkspacePresetFromAgent(
              { sessionId: ctx.sessionId, workspaceSlug, source, allowedOperations, userMessage: ctx.userMessage },
              { presetId: args.fromId, presetScope: args.fromScope },
              args.name,
            ))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  if (source === 'user' && workspaceSlug && ctx.currentPresetReference && allowedOperations.includes('switch')) {
    mutationTools.push(
      sdk.tool(
        'preset_switch_session',
        '仅当当前用户消息明确要求切换本会话预设时使用。返回能力差异和审计 ID；当前轮能力不变，下一轮生效。',
        schemas.switch,
        async (args) => {
          try {
            return jsonResult(switchSessionPresetFromAgent(
              {
                sessionId: ctx.sessionId,
                workspaceSlug,
                source,
                allowedOperations,
                currentPresetReference: ctx.currentPresetReference,
                userMessage: ctx.userMessage,
              },
              { presetId: args.targetId, presetScope: args.targetScope },
            ))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  if (source === 'user' && workspaceSlug && allowedOperations.includes('propose_update')) {
    mutationTools.push(
      sdk.tool(
        'preset_propose_update',
        '仅当当前用户明确要求修改当前工作区自定义预设时使用。只生成提案，不写盘；返回影响摘要后必须等待用户下一条明确确认。',
        schemas.update,
        async (args) => {
          try {
            return jsonResult(proposeAgentPresetUpdateFromAgent(
              { sessionId: ctx.sessionId, workspaceSlug, source, allowedOperations, userMessage: ctx.userMessage },
              { presetId: args.targetId, presetScope: args.targetScope },
              args.updates as AgentPresetUpdateInput,
            ))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  if (source === 'user' && workspaceSlug && allowedOperations.includes('propose_default')) {
    mutationTools.push(
      sdk.tool(
        'preset_request_default_change',
        '仅当当前用户明确要求设置工作区默认预设时使用。只生成提案，不写盘；返回影响摘要后必须等待用户下一条明确确认。',
        schemas.default,
        async (args) => {
          try {
            return jsonResult(proposeAgentPresetDefaultFromAgent(
              { sessionId: ctx.sessionId, workspaceSlug, source, allowedOperations, userMessage: ctx.userMessage },
              { presetId: args.targetId, presetScope: args.targetScope },
            ))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  if (source === 'user' && workspaceSlug && ctx.pendingChange && allowedOperations.includes('commit_change')) {
    mutationTools.push(
      sdk.tool(
        'preset_commit_change',
        '仅当用户刚刚明确确认了当前会话的预设变更提案时使用。无参数提交主进程冻结的提案，模型不能修改提案内容。',
        schemas.commit,
        async () => {
          try {
            return jsonResult(commitPendingAgentPresetChangeFromAgent({
              sessionId: ctx.sessionId,
              workspaceSlug,
              source,
              allowedOperations,
              userMessage: ctx.userMessage,
              pendingChange: ctx.pendingChange,
            }))
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
    )
  }

  const server = sdk.createSdkMcpServer({
    name: 'agent-presets',
    version: '2.0.0',
    tools: [listTool, ...mutationTools],
  })
  mcpServers['agent-presets'] = server as unknown as Record<string, unknown>
}
