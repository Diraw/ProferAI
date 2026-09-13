/** 插件入口及安装列表由主进程配置恢复，使用 Jotai 在界面间共享。 */
import { atom } from 'jotai'
import type { ProferInstalledPlugin } from '@profer/plugin-api'
export const pluginSystemEnabledAtom = atom(false)
export const installedPluginsAtom = atom<ProferInstalledPlugin[]>([])

export const pluginPanelsAtom = atom(new Map<string, { pluginId: string; pageId: string; title: string }>())
