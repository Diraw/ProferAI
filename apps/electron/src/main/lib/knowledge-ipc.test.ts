import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { KNOWLEDGE_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'knowledge-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('知识库 IPC 注册（结构检查）', () => {
  test('覆盖全部资料库通道和输入边界', () => {
    for (const key of ['IMPORT_ITEMS', 'LIST_ITEMS', 'GET_LIBRARY_SNAPSHOT', 'GET_ITEM', 'DELETE_ITEM', 'SEARCH_ITEMS', 'SHOW_ITEM_IN_FOLDER'] as const) expect(source).toContain(`KNOWLEDGE_IPC_CHANNELS.${key}`)
    expect(source).toContain('资料导入数量或路径无效')
    expect(KNOWLEDGE_IPC_CHANNELS.IMPORT_ITEMS).toBeDefined()
  })
  test('ipc.ts 只保留注册入口', () => expect(ipc).toContain('registerKnowledgeIpc()'))
})
