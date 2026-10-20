import { describe, expect, test } from 'bun:test'

// The project-wide Bun suite has other Electron mocks. These pure contract tests avoid
// constructing BrowserWindow, while still protecting the untrusted-URL boundary.

const {
  AgentPreviewRendererError,
  encodePreviewCapture,
  isSafeAgentPreviewSourceUrl,
} = await import('./agent-preview-renderer')

describe('hidden Agent preview renderer', () => {
  test('accepts only opaque profer-file resource URLs', () => {
    expect(isSafeAgentPreviewSourceUrl('profer-file://8f32ce7a-06fb-4b08-9b88-90f9f4f3c07c/index.html')).toBe(true)
    expect(isSafeAgentPreviewSourceUrl('file:///Users/private/deck.pptx')).toBe(false)
    expect(isSafeAgentPreviewSourceUrl('https://example.test/deck.html')).toBe(false)
  })

  test('exports a structured renderer error for lifecycle failures', () => {
    const error = new AgentPreviewRendererError('page_out_of_range', 'out of range', false)
    expect(error).toMatchObject({ code: 'page_out_of_range', retryable: false })
  })

  test('downscales large captures to 1600px and encodes JPEG', () => {
    const jpeg = Buffer.from('jpeg-data')
    let resizedTo: { width: number; height: number } | undefined
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 2560, height: 1736 }),
      resize: (next: { width: number; height: number }) => {
        resizedTo = next
        return image
      },
      toJPEG: () => jpeg,
      toPNG: () => Buffer.from('png-data'),
    } as unknown as Parameters<typeof encodePreviewCapture>[0]

    const result = encodePreviewCapture(image)

    expect(resizedTo).toMatchObject({ width: 1600, height: 1085 })
    expect(result.mediaType).toBe('image/jpeg')
    expect(result.data).toBe(jpeg.toString('base64'))
  })

  test('keeps small captures at original size but still uses JPEG', () => {
    let resizeCalled = false
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => {
        resizeCalled = true
        return image
      },
      toJPEG: () => Buffer.from('jpeg-small'),
      toPNG: () => Buffer.from('png-small'),
    } as unknown as Parameters<typeof encodePreviewCapture>[0]

    const result = encodePreviewCapture(image)

    expect(resizeCalled).toBe(false)
    expect(result.mediaType).toBe('image/jpeg')
  })

  test('falls back to PNG for empty captures', () => {
    const png = Buffer.from('png-empty')
    const image = {
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => image,
      toJPEG: () => Buffer.from(''),
      toPNG: () => png,
    } as unknown as Parameters<typeof encodePreviewCapture>[0]

    expect(encodePreviewCapture(image)).toEqual({ data: png.toString('base64'), mediaType: 'image/png' })
  })
})
