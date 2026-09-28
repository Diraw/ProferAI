/**
 * 本地调用方配对存储
 *
 * 设计文档 §8.1：本地 Agent 首次接入需要用户批准配对，生成可撤销的调用方身份。
 * - token 只存 sha256 哈希，明文仅在配对创建时返回一次；
 * - 撤销后新请求立即拒绝（authenticate 返回 null）；
 * - 存储为配置文件（agent-fabric-clients.json），不用数据库。
 *
 * Phase 1 的“用户批准”动作 = 用户在终端显式执行配对脚本
 * （scripts/agent-fabric-pair.mjs，写入同一配置文件）。
 * 应用内配对审批 UI 属于 Phase 4 范围。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { DEFAULT_PAIRED_AGENT_GRANTS, type CapabilityValue } from '@profer/agent-fabric'

/** 文件中的配对记录：token 仅存哈希。 */
export interface PairedClientRecord {
  clientId: string
  clientName: string
  tokenHash: string
  grants: CapabilityValue[]
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

interface PairingFile {
  clients: PairedClientRecord[]
}

export interface AuthenticatedClient {
  clientId: string
  clientName: string
  grants: CapabilityValue[]
}

export function getPairingFilePath(): string {
  return join(getConfigDir(), 'agent-fabric-clients.json')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readPairingFile(path: string): PairingFile {
  if (!existsSync(path)) return { clients: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as PairingFile
    return { clients: Array.isArray(raw.clients) ? raw.clients : [] }
  } catch {
    return { clients: [] }
  }
}

function writePairingFile(path: string, file: PairingFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8')
}

/**
 * 创建配对（用户批准动作）。
 * 返回的 token 明文只出现这一次，调用方负责安全展示给用户。
 */
export function pairClient(
  clientName: string,
  grants: readonly CapabilityValue[] = DEFAULT_PAIRED_AGENT_GRANTS,
  filePath: string = getPairingFilePath(),
): { clientId: string; token: string } {
  const file = readPairingFile(filePath)
  const clientId = `client_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  file.clients.push({
    clientId,
    clientName,
    tokenHash: hashToken(token),
    grants: [...grants],
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  })
  writePairingFile(filePath, file)
  return { clientId, token }
}

/** Bearer token 认证。撤销后、未知 token 一律返回 null（拒绝）。 */
export function authenticateToken(token: string, filePath: string = getPairingFilePath()): AuthenticatedClient | null {
  const file = readPairingFile(filePath)
  const hash = hashToken(token)
  const record = file.clients.find((client) => client.tokenHash === hash)
  if (!record) return null
  if (record.revokedAt !== undefined && record.revokedAt <= Date.now()) return null

  record.lastSeenAt = Date.now()
  writePairingFile(filePath, file)
  return { clientId: record.clientId, clientName: record.clientName, grants: record.grants }
}

/** 撤销配对：立即生效。 */
export function revokeClient(clientId: string, filePath: string = getPairingFilePath()): boolean {
  const file = readPairingFile(filePath)
  const record = file.clients.find((client) => client.clientId === clientId)
  if (!record || record.revokedAt !== undefined) return false
  record.revokedAt = Date.now()
  writePairingFile(filePath, file)
  return true
}

export function listPairedClients(filePath: string = getPairingFilePath()): PairedClientRecord[] {
  return readPairingFile(filePath).clients
}
