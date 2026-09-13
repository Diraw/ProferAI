import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { PROFER_PLUGIN_IPC_CHANNELS, type ProferPluginRoutingRule, type ProferPluginRoutingState } from '@profer/plugin-api'
import { supportsPluginModel } from './plugin-model-availability'
import { getConfigDir } from '../config-paths'
import { listChannels } from '../channel-manager'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getInstalledPlugin } from './plugin-manager'
import { assertPluginPermission } from './plugin-permissions'
import { routingRulesSchema } from './plugin-capabilities'

interface RoutingFile { rules: Record<string, ProferPluginRoutingRule[]>; sessions: Record<string, ProferPluginRoutingState> }
function path(): string { return join(getConfigDir(), 'plugin-routing.json') }
function read(): RoutingFile {
  const value = readJsonFileSafe<RoutingFile>(path())
  return { rules: value?.rules ?? {}, sessions: value?.sessions ?? {} }
}
export function getPluginRoutingRules(pluginId: string): ProferPluginRoutingRule[] {
  assertPluginPermission(pluginId, 'modelRouting.rules.write')
  return routingRulesSchema.parse(read().rules[pluginId] ?? [])
}
export function setPluginRoutingRules(pluginId: string, input: unknown): void {
  assertPluginPermission(pluginId, 'modelRouting.rules.write')
  if (!getInstalledPlugin(pluginId)?.manifest.contributes.modelRoutingPolicies?.length) throw new Error('插件未声明模型路由贡献')
  const rules = routingRulesSchema.parse(input)
  const channels = listChannels()
  for (const rule of rules) {
    if (!channels.some((channel) => channel.enabled && channel.id === rule.channelId && channel.models.some((model) => model.enabled && model.id === rule.modelId))) {
      throw new Error(`规则「${rule.title}」的模型不可用`)
    }
  }
  const file = read(); file.rules[pluginId] = rules; writeJsonFileAtomic(path(), file)
}
export function getTaskRouting(key: string): ProferPluginRoutingState { return read().sessions[key] ?? { pluginId: null } }
export function setTaskRouting(key: string, pluginId: string | null): void {
  if (!/^(chat|agent):.{1,200}$/.test(key)) throw new Error('任务标识非法')
  if (pluginId !== null) {
    assertPluginPermission(pluginId, 'modelRouting.rules.write')
    if (!getInstalledPlugin(pluginId)?.manifest.contributes.modelRoutingPolicies?.length) throw new Error('插件不提供路由')
  }
  const file = read(); file.sessions[key] = { pluginId }; writeJsonFileAtomic(path(), file)
}
export function matchesRoutingTime(rule: ProferPluginRoutingRule, now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes()
  const time = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const start = time(rule.start), end = time(rule.end)
  // 跨午夜规则的凌晨部分属于前一天开始的时段。
  const day = start > end && minutes < end ? (now.getDay() + 6) % 7 : now.getDay()
  if (rule.days && !rule.days.includes(day)) return false
  return start === end || (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end)
}
/** 每轮只调用一次；失败保留用户原先选择，绝不在工具循环中更换模型。 */
export function routePluginModel<T extends { channelId: string; modelId?: string }>(key: string, input: T, runtime: 'claude' | 'pi' = 'claude'): T {
  try {
    const file = read(), state = file.sessions[key]
    if (!state?.pluginId) return input
    let reason = '插件不可用，使用手动选择的模型'
    let result = input
    try {
      const channels = listChannels()
      const rule = getPluginRoutingRules(state.pluginId).find((candidate) => matchesRoutingTime(candidate, new Date())
        && channels.some((channel) => channel.enabled && channel.id === candidate.channelId
          && supportsPluginModel(channel, key.startsWith('agent:') ? 'agent' : 'chat', runtime)
          && channel.models.some((model) => model.enabled && model.id === candidate.modelId)))
      if (rule) {
        result = { ...input, channelId: rule.channelId, modelId: rule.modelId }
        reason = `${getInstalledPlugin(state.pluginId)?.manifest.name} · ${rule.title}`
      } else reason = '没有匹配的可用规则，使用手动选择的模型'
    } catch { /* 撤权、停用、模型配置变化时回退 */ }
    state.lastDecision = { channelId: result.channelId, modelId: result.modelId ?? '', reason, at: Date.now() }
    writeJsonFileAtomic(path(), file)
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PROFER_PLUGIN_IPC_CHANNELS.ROUTING_CHANGED, { key, state })
    return result
  } catch (error) {
    console.warn('[插件] 路由读取失败，使用原始模型:', error instanceof Error ? error.message : '未知错误')
    return input
  }
}
