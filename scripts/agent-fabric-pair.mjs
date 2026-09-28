#!/usr/bin/env node
/**
 * Agent Fabric 本地配对脚本（Phase 1 的「用户批准」动作）
 *
 * 用法：
 *   node scripts/agent-fabric-pair.mjs --name hermes
 *   node scripts/agent-fabric-pair.mjs --name hermes --grants task.submit,task.read,task.cancel,artifact.read
 *   node scripts/agent-fabric-pair.mjs --revoke <clientId>
 *
 * 说明：
 * - 写入与 Profer 应用相同的配对文件（agent-fabric-clients.json，token 只存 sha256 哈希）；
 * - token 明文只在本脚本输出中出现一次，请立即保存到调用方的安全存储；
 * - --dev 或 PROFER_DEV=1 时写入开发版配置目录（~/.profer-dev/）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_GRANTS = ['task.submit', 'task.read', 'task.cancel', 'artifact.read']

function parseArgs(argv) {
  const args = { grants: DEFAULT_GRANTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--name') args.name = argv[++i]
    else if (arg === '--grants') args.grants = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--revoke') args.revoke = argv[++i]
    else if (arg === '--dev') args.dev = true
    else if (arg === '--list') args.list = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function getConfigDir(dev) {
  const override = process.env.PROFER_CONFIG_DIR?.trim()
  if (override) return resolve(override)
  return join(homedir(), dev || process.env.PROFER_DEV === '1' ? '.profer-dev' : '.profer')
}

const args = parseArgs(process.argv.slice(2))
if (args.help || (!args.name && !args.revoke && !args.list)) {
  console.log('用法: agent-fabric-pair.mjs (--name <名称> [--grants a,b,c] | --revoke <clientId> | --list) [--dev]')
  process.exit(args.help ? 0 : 1)
}

const filePath = join(getConfigDir(args.dev), 'agent-fabric-clients.json')
const file = existsSync(filePath)
  ? JSON.parse(readFileSync(filePath, 'utf-8'))
  : { clients: [] }
file.clients = Array.isArray(file.clients) ? file.clients : []

if (args.list) {
  for (const c of file.clients) {
    console.log(`${c.revokedAt ? '[已撤销]' : '[生效中]'} ${c.clientId}  ${c.clientName}  grants=${c.grants.join(',')}`)
  }
  process.exit(0)
}

if (args.revoke) {
  const record = file.clients.find((c) => c.clientId === args.revoke)
  if (!record) {
    console.error(`未找到 clientId=${args.revoke}`)
    process.exit(1)
  }
  record.revokedAt = Date.now()
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')
  console.log(`已撤销 ${record.clientName}（${record.clientId}），新请求立即被拒绝`)
  process.exit(0)
}

const clientId = `client_${randomUUID().replace(/-/g, '').slice(0, 16)}`
const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
file.clients.push({
  clientId,
  clientName: args.name,
  tokenHash: createHash('sha256').update(token).digest('hex'),
  grants: args.grants,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
})
mkdirSync(join(filePath, '..'), { recursive: true })
writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')

console.log(`配对成功：${args.name}`)
console.log(`  clientId: ${clientId}`)
console.log(`  grants:   ${args.grants.join(', ')}`)
console.log(`  token:    ${token}`)
console.log('')
console.log('注意：token 只显示这一次。撤销请使用 --revoke ' + clientId)
