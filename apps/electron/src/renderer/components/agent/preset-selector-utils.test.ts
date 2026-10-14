import { describe, expect, test } from 'bun:test'
import type { AgentPreset } from '@profer/shared'
import {
  referenceForSelectablePreset,
  selectableAgentPresets,
  selectablePresetMatchesReference,
} from './preset-selector-utils'

function preset(input: Partial<AgentPreset> & Pick<AgentPreset, 'id'>): AgentPreset {
  return {
    name: input.id,
    description: '',
    isBuiltin: false,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

describe('预设选择器稳定引用', () => {
  test('工作区岗位切换时携带作用域、工作区和版本', () => {
    const candidate = preset({ id: 'renderer', scope: 'workspace', workspaceSlug: 'profer', version: '1.2.3' })
    expect(referenceForSelectablePreset(candidate, 'profer')).toEqual({
      presetId: 'renderer',
      presetScope: 'workspace',
      workspaceSlug: 'profer',
      presetVersion: '1.2.3',
    })
  })

  test('元预设和同 ID 工作区预设不会被误判成同一个选择', () => {
    const builtin = preset({ id: 'code', scope: 'builtin-meta', isBuiltin: true })
    const workspace = preset({ id: 'code', scope: 'workspace' })
    const reference = referenceForSelectablePreset(builtin, 'profer')

    expect(selectablePresetMatchesReference(builtin, reference)).toBe(true)
    expect(selectablePresetMatchesReference(workspace, reference)).toBe(false)
  })
})

describe('可选预设列表', () => {
  test('明确停用的预设（含元预设）不进入可选列表，未声明的视为可用', () => {
    const list = [
      preset({ id: 'on', enabledInWorkspace: true }),
      preset({ id: 'off', enabledInWorkspace: false }),
      preset({ id: 'unknown' }),
    ]
    expect(selectableAgentPresets(list).map((item) => item.id)).toEqual(['on', 'unknown'])
  })

  test('返回新数组，不修改入参', () => {
    const list = [preset({ id: 'off', enabledInWorkspace: false })]
    expect(selectableAgentPresets(list)).toEqual([])
    expect(list).toHaveLength(1)
  })
})
