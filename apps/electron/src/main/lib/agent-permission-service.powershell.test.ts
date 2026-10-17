import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions, type PermissionUpdate } from './agent-permission-service'

const OPTIONS: CanUseToolOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-id',
}

function createWorkerOptions(): CanUseToolOptions {
  return { ...OPTIONS, agentID: 'worker-id' }
}

describe('AgentPermissionService PowerShell handling', () => {
  test('Given a main-agent read-only PowerShell query When permission is checked Then it is allowed without an approval request', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {
      throw new Error('read-only command must not request approval')
    })('PowerShell', { command: 'Get-Location' }, OPTIONS)

    expect(result.behavior).toBe('allow')
  })

  test('Given a main-agent PowerShell content read or mutation When permission is checked Then it requests approval instead of auto-allowing', async () => {
    const service = new AgentPermissionService()
    const pending = service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Get-Content $HOME\\.ssh\\id_rsa',
    }, OPTIONS)

    expect(service.getPendingRequests()).toHaveLength(1)
    const request = service.getPendingRequests()[0]!
    expect(request.command).toBe('Get-Content $HOME\\.ssh\\id_rsa')
    expect(request.description).toContain('执行 PowerShell')
    service.respondToPermission(request.requestId, 'deny', false)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', toolUseID: 'tool-use-id', decisionClassification: 'user_reject' })
  })

  test('Given SDK permission metadata When a user approves permanently Then request and result preserve correlation and permission updates', async () => {
    const service = new AgentPermissionService()
    const requests: Array<import('@profer/shared').PermissionRequest> = []
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }]
    const pending = service.createCanUseTool('metadata-session', (request) => requests.push(request))('Write', { file_path: '/tmp/fixture' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-use-42',
      suggestions: [...suggestions],
      blockedPath: '/tmp/fixture',
      decisionReason: 'classifier requested confirmation',
      decisionReasonType: 'classifier',
      classifierApprovable: true,
      title: 'Write fixture',
      displayName: 'Write',
      description: 'Write fixture content',
    })
    expect(requests[0]).toMatchObject({ toolUseID: 'tool-use-42', blockedPath: '/tmp/fixture', decisionReasonType: 'classifier', suggestions })
    service.respondToPermission(requests[0]!.requestId, 'allow', true)
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', toolUseID: 'tool-use-42', decisionClassification: 'user_permanent', updatedPermissions: suggestions })
    service.clearSessionPending('metadata-session')
    service.clearSessionWhitelist('metadata-session')
  })

  test('Given a worker PowerShell mutation When permission is checked Then it is rejected because workers cannot request interactive approval', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Remove-Item C:\\temp\\x',
    }, createWorkerOptions())

    expect(result).toMatchObject({ behavior: 'deny', interrupt: true, toolUseID: 'tool-use-id' })
  })

  test('Given a worker read-only PowerShell query When permission is checked Then it remains allowed', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Get-Process -Name explorer',
    }, createWorkerOptions())

    expect(result).toMatchObject({ behavior: 'allow', toolUseID: 'tool-use-id' })
  })
})
