import { BrowserWindow, ipcMain } from 'electron'
import { VOICE_DICTATION_IPC_CHANNELS } from '../../types'
import type {
  MicPermissionResult,
  VoiceDictationAudioChunkInput,
  VoiceDictationCommitInput,
  VoiceDictationCommitResult,
  VoiceDictationResizeInput,
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationStartInput,
  VoiceDictationStopInput,
  VoiceDictationTestResult,
} from '../../types'

export function registerVoiceDictationIpc(): void {
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS, async (): Promise<VoiceDictationSettings> => {
    const { getVoiceDictationSettings } = await import('./voice-dictation-settings-service')
    return getVoiceDictationSettings()
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.UPDATE_SETTINGS, async (_, updates: VoiceDictationSettingsUpdate): Promise<VoiceDictationSettings> => {
    const { updateVoiceDictationSettings } = await import('./voice-dictation-settings-service')
    return updateVoiceDictationSettings(updates)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.TEST_CONNECTION, async (_, updates?: VoiceDictationSettingsUpdate): Promise<VoiceDictationTestResult> => {
    const { getVoiceDictationSettings } = await import('./voice-dictation-settings-service')
    const { testDoubaoAsrConnection } = await import('./doubao-asr-service')
    return testDoubaoAsrConnection({ ...getVoiceDictationSettings(), ...(updates ?? {}) })
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.TOGGLE, async (event): Promise<void> => {
    const { toggleVoiceDictationWindow } = await import('./voice-dictation-window')
    toggleVoiceDictationWindow({ targetIsProfer: !!BrowserWindow.fromWebContents(event.sender) })
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.START, async (event, input: VoiceDictationStartInput): Promise<void> => {
    const { getVoiceDictationSettings } = await import('./voice-dictation-settings-service')
    const { startDoubaoAsrSession } = await import('./doubao-asr-service')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('语音输入窗口不存在')
    await startDoubaoAsrSession(input.sessionId, getVoiceDictationSettings(), win)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.SEND_AUDIO, async (_, input: VoiceDictationAudioChunkInput): Promise<void> => {
    const { sendDoubaoAsrAudio } = await import('./doubao-asr-service')
    sendDoubaoAsrAudio(input.sessionId, input.data)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.STOP, async (_, input: VoiceDictationStopInput): Promise<void> => {
    const { stopDoubaoAsrSession } = await import('./doubao-asr-service')
    await stopDoubaoAsrSession(input.sessionId)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.CANCEL, async (_, input: VoiceDictationStopInput): Promise<void> => {
    const { cancelDoubaoAsrSession } = await import('./doubao-asr-service')
    cancelDoubaoAsrSession(input.sessionId)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.COMMIT, async (_, input: VoiceDictationCommitInput): Promise<VoiceDictationCommitResult> => {
    const { getVoiceDictationSettings } = await import('./voice-dictation-settings-service')
    const { commitVoiceDictationText } = await import('./text-output-service')
    return commitVoiceDictationText(input.text, getVoiceDictationSettings())
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.HIDE, async (): Promise<void> => {
    const { hideVoiceDictationWindow } = await import('./voice-dictation-window')
    hideVoiceDictationWindow()
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.RESIZE, async (_, input: VoiceDictationResizeInput): Promise<void> => {
    const { resizeVoiceDictationWindow } = await import('./voice-dictation-window')
    resizeVoiceDictationWindow(input.height)
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.CHECK_MIC_PERMISSION, async (): Promise<MicPermissionResult> => {
    const { checkMicrophonePermission } = await import('./microphone-permission-service')
    return checkMicrophonePermission()
  })
  ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.REQUEST_MIC_PERMISSION, async (): Promise<MicPermissionResult> => {
    const { requestMicrophonePermission } = await import('./microphone-permission-service')
    return requestMicrophonePermission()
  })
}
