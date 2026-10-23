import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Type } from 'typebox'
import {
  buildTypeBoxDelegationPresetReferenceSchema,
  buildZodDelegationPresetReferenceSchema,
} from './agent-delegation-preset-schema'

describe('delegation presetReference schema parity', () => {
  test('Claude schema accepts all supported stable reference fields', () => {
    const schema = buildZodDelegationPresetReferenceSchema(z)
    expect(schema.safeParse({
      presetId: 'review',
      presetScope: 'workspace',
      workspaceSlug: 'workspace-a',
      presetVersion: 'v3',
    }).success).toBe(true)
  })

  test('Claude schema rejects blank ID and unknown scope', () => {
    const schema = buildZodDelegationPresetReferenceSchema(z)
    expect(schema.safeParse({ presetId: ' ', presetScope: 'workspace' }).success).toBe(false)
    expect(schema.safeParse({ presetId: 'review', presetScope: 'unknown' }).success).toBe(false)
  })

  test('Pi schema exposes the same fields and scope enum', () => {
    const schema = buildTypeBoxDelegationPresetReferenceSchema(Type) as {
      properties: Record<string, unknown>
    }
    expect(schema.properties).toHaveProperty('presetId')
    expect(schema.properties).toHaveProperty('presetScope')
    expect(schema.properties).toHaveProperty('workspaceSlug')
    expect(schema.properties).toHaveProperty('presetVersion')
  })

  // 模型补字段的直接诱因是「字段可选但没说什么时候才该填」：两份 schema 必须
  // 都带上同样的条件说明，且整体描述要求照抄 preset_list 返回的引用。
  test('两份 schema 都给 workspaceSlug 标注仅 workspace 作用域使用', () => {
    const zodSchema = buildZodDelegationPresetReferenceSchema(z)
    const zodWorkspaceSlug = zodSchema.unwrap().shape.workspaceSlug
    const typeboxSchema = buildTypeBoxDelegationPresetReferenceSchema(Type) as {
      properties: { workspaceSlug: { description?: string } }
    }

    expect(zodWorkspaceSlug.description).toContain('presetScope=workspace')
    expect(typeboxSchema.properties.workspaceSlug.description).toContain('presetScope=workspace')
    expect(zodWorkspaceSlug.description).toBe(typeboxSchema.properties.workspaceSlug.description)
  })

  test('两份 schema 都要求照抄 preset_list 引用、不要自行补字段', () => {
    const zodSchema = buildZodDelegationPresetReferenceSchema(z)
    const typeboxSchema = buildTypeBoxDelegationPresetReferenceSchema(Type) as {
      description?: string
    }

    expect(zodSchema.description).toContain('preset_list')
    expect(zodSchema.description).toContain('不要自行补字段')
    expect(typeboxSchema.description).toBe(zodSchema.description)
  })
})
