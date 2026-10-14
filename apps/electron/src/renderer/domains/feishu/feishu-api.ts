/**
 * Feishu renderer domain 的宿主访问层。
 *
 * 每个函数都在调用时才读取 window.electronAPI，签名与 preload 声明逐项一致，
 * 不做缓存、重试或请求合并。页面组件只依赖这里导出的函数，不再直接访问 electronAPI。
 */

type Host = Window['electronAPI']

function host(): Host {
  return window.electronAPI
}

export const getPlatformInfo: Host['getPlatformInfo'] = (...args) => host().getPlatformInfo(...args)
export const openExternal: Host['openExternal'] = (...args) => host().openExternal(...args)
export const getSettings: Host['getSettings'] = (...args) => host().getSettings(...args)
export const updateSettings: Host['updateSettings'] = (...args) => host().updateSettings(...args)

export const getFeishuConfig: Host['getFeishuConfig'] = (...args) => host().getFeishuConfig(...args)
export const getFeishuMultiConfig: Host['getFeishuMultiConfig'] = (...args) => host().getFeishuMultiConfig(...args)
export const getFeishuMultiStatus: Host['getFeishuMultiStatus'] = (...args) => host().getFeishuMultiStatus(...args)
export const getDecryptedFeishuSecret: Host['getDecryptedFeishuSecret'] = (...args) => host().getDecryptedFeishuSecret(...args)
export const getDecryptedFeishuBotSecret: Host['getDecryptedFeishuBotSecret'] = (...args) => host().getDecryptedFeishuBotSecret(...args)
export const saveFeishuBotConfig: Host['saveFeishuBotConfig'] = (...args) => host().saveFeishuBotConfig(...args)
export const testFeishuConnection: Host['testFeishuConnection'] = (...args) => host().testFeishuConnection(...args)
export const startFeishuBot: Host['startFeishuBot'] = (...args) => host().startFeishuBot(...args)
export const stopFeishuBot: Host['stopFeishuBot'] = (...args) => host().stopFeishuBot(...args)
export const removeFeishuBot: Host['removeFeishuBot'] = (...args) => host().removeFeishuBot(...args)

export const listFeishuBindings: Host['listFeishuBindings'] = (...args) => host().listFeishuBindings(...args)
export const updateFeishuBinding: Host['updateFeishuBinding'] = (...args) => host().updateFeishuBinding(...args)
export const removeFeishuBinding: Host['removeFeishuBinding'] = (...args) => host().removeFeishuBinding(...args)

export const registerFeishuApp: Host['registerFeishuApp'] = (...args) => host().registerFeishuApp(...args)
export const cancelFeishuRegistration: Host['cancelFeishuRegistration'] = (...args) => host().cancelFeishuRegistration(...args)
export const onFeishuRegisterQrcode: Host['onFeishuRegisterQrcode'] = (...args) => host().onFeishuRegisterQrcode(...args)
export const onFeishuRegisterStatus: Host['onFeishuRegisterStatus'] = (...args) => host().onFeishuRegisterStatus(...args)

export const getLarkMcpStatus: Host['getLarkMcpStatus'] = (...args) => host().getLarkMcpStatus(...args)
export const saveLarkMcpCredentials: Host['saveLarkMcpCredentials'] = (...args) => host().saveLarkMcpCredentials(...args)
export const testLarkMcpConnection: Host['testLarkMcpConnection'] = (...args) => host().testLarkMcpConnection(...args)
export const startLarkMcpLogin: Host['startLarkMcpLogin'] = (...args) => host().startLarkMcpLogin(...args)
export const cancelLarkMcpLogin: Host['cancelLarkMcpLogin'] = (...args) => host().cancelLarkMcpLogin(...args)
export const onLarkMcpLoginEvent: Host['onLarkMcpLoginEvent'] = (...args) => host().onLarkMcpLoginEvent(...args)
export const enableLarkMcpForWorkspace: Host['enableLarkMcpForWorkspace'] = (...args) => host().enableLarkMcpForWorkspace(...args)
export const disableLarkMcpForWorkspace: Host['disableLarkMcpForWorkspace'] = (...args) => host().disableLarkMcpForWorkspace(...args)

export const refreshLarkCliStatus: Host['refreshLarkCliStatus'] = (...args) => host().refreshLarkCliStatus(...args)
export const installLarkCli: Host['installLarkCli'] = (...args) => host().installLarkCli(...args)
export const startLarkLogin: Host['startLarkLogin'] = (...args) => host().startLarkLogin(...args)
export const cancelLarkLogin: Host['cancelLarkLogin'] = (...args) => host().cancelLarkLogin(...args)
export const onLarkLoginEvent: Host['onLarkLoginEvent'] = (...args) => host().onLarkLoginEvent(...args)
