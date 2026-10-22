/**
 * 模型请求图片编码：等比缩放 + JPEG，按 base64 字节预算逐级降质。
 *
 * 刻意不导入 Electron：调用方传入满足最小接口的图片源，单测可直接用替身。
 * 真实宿主在 `agent-image-compression.ts` 里用 nativeImage 适配。
 */

export interface ModelImageTranscodeOptions {
  /** 输出图片最长边（像素）。 */
  maxSide: number
  /** 初始 JPEG 质量，0-100。 */
  quality: number
  /** 输出 base64 字符串长度上限。 */
  maxBase64Bytes: number
}

export interface ModelImageTranscodeResult {
  data: string
  mimeType: 'image/jpeg'
  width: number
  height: number
  /** JPEG 原始字节数（不是 base64 长度）。 */
  bytes: number
}

/** nativeImage / 测试替身共享的最小图片源接口。 */
export interface ModelImageSource {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'good' }): ModelImageSource
  toJPEG(quality: number): Buffer
}

const MIN_JPEG_QUALITY = 40
const QUALITY_STEP = 10
const DOWNSCALE_STEP = 0.8

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 82
  return Math.max(MIN_JPEG_QUALITY, Math.min(95, Math.round(quality)))
}

/**
 * 把图片源压到最长边和 base64 字节预算以内。
 *
 * 先降 JPEG 质量，再按 0.8 倍逐级缩小尺寸；两者都到极限仍超限时返回 null，
 * 由调用方决定保留原图还是省略，避免把“压缩失败”误当成“压缩成功”。
 */
export function encodeModelImage(
  image: ModelImageSource | null | undefined,
  options: ModelImageTranscodeOptions,
): ModelImageTranscodeResult | null {
  try {
    if (!image || image.isEmpty()) return null
    const sourceSize = image.getSize()
    if (!sourceSize.width || !sourceSize.height) return null

    const longestSide = Math.max(sourceSize.width, sourceSize.height)
    const scale = longestSide > options.maxSide ? options.maxSide / longestSide : 1
    let current = scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(sourceSize.width * scale)),
          height: Math.max(1, Math.round(sourceSize.height * scale)),
          quality: 'good',
        })
      : image

    let quality = clampQuality(options.quality)
    let jpeg = current.toJPEG(quality)

    while (jpeg.length > 0 && base64Length(jpeg.length) > options.maxBase64Bytes && quality > MIN_JPEG_QUALITY) {
      quality = Math.max(MIN_JPEG_QUALITY, quality - QUALITY_STEP)
      jpeg = current.toJPEG(quality)
    }

    while (jpeg.length > 0 && base64Length(jpeg.length) > options.maxBase64Bytes) {
      const currentSize = current.getSize()
      const nextWidth = Math.max(1, Math.floor(currentSize.width * DOWNSCALE_STEP))
      const nextHeight = Math.max(1, Math.floor(currentSize.height * DOWNSCALE_STEP))
      if (nextWidth === currentSize.width && nextHeight === currentSize.height) break
      current = current.resize({ width: nextWidth, height: nextHeight, quality: 'good' })
      jpeg = current.toJPEG(quality)
    }

    if (jpeg.length === 0) return null
    const finalSize = current.getSize()
    return {
      data: jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      width: finalSize.width,
      height: finalSize.height,
      bytes: jpeg.length,
    }
  } catch {
    return null
  }
}
