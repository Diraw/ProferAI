import { describe, expect, test } from 'bun:test'
import { DEV_DIAGNOSTICS_MAX_BYTES, shouldRotateDiagnosticsLog } from './dev-diagnostics-log'

describe('shouldRotateDiagnosticsLog', () => {
  test('未达上限时保留既有日志', () => {
    expect(shouldRotateDiagnosticsLog(0)).toBe(false)
    expect(shouldRotateDiagnosticsLog(DEV_DIAGNOSTICS_MAX_BYTES - 1)).toBe(false)
  })

  test('达到或超过上限时触发轮转', () => {
    expect(shouldRotateDiagnosticsLog(DEV_DIAGNOSTICS_MAX_BYTES)).toBe(true)
    expect(shouldRotateDiagnosticsLog(DEV_DIAGNOSTICS_MAX_BYTES * 3)).toBe(true)
  })
})
