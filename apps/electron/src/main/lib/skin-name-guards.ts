/**
 * 皮肤包命名的跨平台守卫。
 *
 * 独立成无 Electron 依赖的纯模块：安装服务、Agent 皮肤工具和单测共用同一套判断，避免正则双写漂移。
 */

const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 判断名称是否为 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）。
 *
 * Windows 既不允许这些名字作为文件/目录名，也不允许带扩展名的形式（`CON.png` 同样失败），
 * 因此调用方必须以去掉扩展名后的词干为准传入。
 *
 * 皮肤包会跨平台分享，所以在所有平台统一拒绝（而不是只在 win32 生效），
 * 保证同一个皮肤包在 macOS 上制作后也能在 Windows 安装。
 */
export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME_RE.test(name.trim())
}
