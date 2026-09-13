const api = window.profer
const el = (id) => document.getElementById(id)
let models = []
let activeRequest = null
const requestId = () => crypto.randomUUID()
const selectedModel = () => {
  const model = models[Number(el('model').value)]
  if (!model) throw new Error('请先选择可用模型')
  return model
}
const output = (value) => { el('output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
const action = (id, handler) => el(id).addEventListener('click', async () => {
  el('status').textContent = '正在处理…'
  try { await handler(); el('status').textContent = '已完成' }
  catch (error) { el('status').textContent = error.message || String(error) }
})
async function refresh() {
  models = (await api.models.list()).filter((model) => model.available && model.supportsChat)
  el('model').replaceChildren(...models.map((model, index) => new Option(`${model.channelName} · ${model.name}`, String(index))))
  const saved = await api.storage.get('model')
  const index = models.findIndex((model) => model.channelId === saved?.channelId && model.modelId === saved?.modelId)
  if (index >= 0) el('model').value = String(index)
  el('rules').textContent = JSON.stringify(await api.routing.getRules(), null, 2)
}
async function summarize(text, model, id) {
  return api.models.generate({ requestId: id, channelId: model.channelId, modelId: model.modelId, prompt: `请简洁总结以下文本：\n${text}`, maxTokens: 1024 })
}
void api.tools.register('uppercase', async ({ text }) => ({ text: text.toUpperCase() })).catch(() => {})
void api.tools.register('summarize', async ({ text }, context) => {
  const model = await api.storage.get('model')
  if (!model) throw new Error('请先在插件工具箱中保存默认模型')
  const id = requestId()
  const unsubscribe = context.onCancel(() => { void api.requests.cancel(id) })
  try { if (context.isCancelled()) throw new Error('已取消'); return await summarize(text, model, id) }
  finally { unsubscribe() }
}).catch(() => {})
action('refresh', refresh)
action('save-model', async () => { const { channelId, modelId } = selectedModel(); await api.storage.set('model', { channelId, modelId }) })
action('save-rule', async () => {
  const { channelId, modelId } = selectedModel()
  await api.routing.setRules([{ id: 'daily', title: '每日时段', channelId, modelId, start: el('start').value, end: el('end').value }])
  el('rules').textContent = JSON.stringify(await api.routing.getRules(), null, 2)
})
action('context', async () => {
  const context = await api.context.read()
  if (!context) throw new Error('请从任务或消息上的插件入口打开此页面')
  el('input').value = context.selection || context.messages.map((message) => message.text).join('\n\n')
})
action('attachments', async () => { const files = await api.attachments.select(); el('input').value = files.map((file) => `${file.name}\n${file.text}`).join('\n\n') })
action('generate', async () => {
  if (activeRequest) throw new Error('已有调用正在进行')
  const id = requestId(); activeRequest = id
  try { output((await summarize(el('input').value, selectedModel(), id)).text) } finally { activeRequest = null }
})
action('cancel', async () => { if (activeRequest) await api.requests.cancel(activeRequest) })
action('fetch', async () => {
  if (activeRequest) throw new Error('已有调用正在进行')
  const id = requestId(); activeRequest = id
  try { output(await api.network.fetch({ requestId: id, url: 'https://example.com/' })) } finally { activeRequest = null }
})
void refresh().then(() => { el('status').textContent = '已就绪' }).catch((error) => { el('status').textContent = error.message })
