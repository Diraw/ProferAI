import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '', isPackaged: false },
  clipboard: {}, dialog: {}, nativeImage: {}, nativeTheme: {}, Notification: class {},
  powerMonitor: {}, powerSaveBlocker: {}, safeStorage: {}, screen: {}, shell: {}, systemPreferences: {},
}))
// 本文件只验证标题重生成，不启动真实 agent 链路；mock 必须覆盖被间接加载的调用方
// （remote-service / automation-scheduler）从 agent-service 取用的全部导出，
// 否则 import 期就会抛 “Export named ... not found”，整文件静默失效。
mock.module('./agent-service', () => ({
  agentEventBus: { on() {}, emit() {} }, onAgentRunComplete() {},
  runAgentHeadless() {}, runAgentRuntimeHeadless() {}, stopAgent() {}, isAgentSessionActive: () => false,
  listActiveAgentRuntimeContexts: () => [], updateAgentPermissionMode: async () => {},
  queueAgentMessage: async () => {}, beginAgentSessionDeletion() {}, endAgentSessionDeletion() {},
  stopAgentAndWait: async () => {}, rewindAgentSession: async () => {}, regenerateAgentTitle: async () => null,
  peekAgentRunClaimFailureForSession: () => undefined, describeAgentRunRejection: () => 'fixture rejection',
}))
const { AgentOrchestrator } = await import('./agent-orchestrator')
const sessions = await import('./agent-session-manager')
const paths = await import('./config-paths')
let root = ''
const previousConfig = process.env.PROFER_CONFIG_DIR
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'profer-title-')); process.env.PROFER_CONFIG_DIR = root })
afterEach(() => { mock.restore(); if (previousConfig === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = previousConfig; rmSync(root, { recursive: true, force: true }) })

test.each(['claude', 'pi'] as const)('%s：真实落盘用户消息可以重新生成标题', async (runtime) => {
  const meta = sessions.createAgentSession('新 Agent 会话', undefined, undefined, undefined, runtime)
  mkdirSync(paths.getAgentSessionsDir(), { recursive: true })
  writeFileSync(paths.getAgentSessionMessagesPath(meta.id), [
    { type: 'user', message: { content: [{ type: 'text', text: '给我谈谈grok和gpt' }] }, parent_tool_use_id: null },
    // 历史/中断写入可能留下不完整的 user content；不能让它遮蔽前面的有效消息。
    { type: 'user', message: { content: [null] }, parent_tool_use_id: null },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n')
  const orchestrator = new AgentOrchestrator({} as never, { on() {}, emit() {} } as never)
  const generate = spyOn(orchestrator, 'generateTitle').mockResolvedValue('Grok与GPT比较')
  expect(await orchestrator.regenerateTitle(meta.id, 'fixture', 'model')).toBe('Grok与GPT比较')
  expect(generate.mock.calls[0]?.[0].contextMessages).toEqual(['给我谈谈grok和gpt'])
  expect(sessions.getAgentSessionMeta(meta.id)?.title).toBe('Grok与GPT比较')
})
