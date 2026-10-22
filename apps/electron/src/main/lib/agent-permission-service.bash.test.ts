import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

const OPTIONS: CanUseToolOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-id',
}

describe('AgentPermissionService Bash auto 模式', () => {
  test('Given 只读 git 命令 When 权限检查 Then 自动放行且不弹审批', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {
      throw new Error('只读命令不应请求审批')
    })('Bash', { command: 'git status --short' }, OPTIONS)

    expect(result.behavior).toBe('allow')
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  for (const command of [
    'git branch -D main',
    'git diff --output=/tmp/x.patch',
    'git tag -d v1.0.0',
    'rg --pre /tmp/evil.sh TODO .',
    'file -C -m /tmp/magic',
  ]) {
    test(`Given 带副作用命令「${command}」When 权限检查 Then 请求审批而不是自动放行`, async () => {
      const service = new AgentPermissionService()
      const pending = service.createCanUseTool('session', () => {})('Bash', { command }, OPTIONS)

      expect(service.getPendingRequests()).toHaveLength(1)
      const request = service.getPendingRequests()[0]!
      service.respondToPermission(request.requestId, 'deny', false)
      await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
    })
  }
})
