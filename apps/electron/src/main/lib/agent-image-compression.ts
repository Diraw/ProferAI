/**
 * 主进程图片压缩适配。
 *
 * - `encodeModelImage` 负责纯编码；本文件只把 Electron nativeImage 接上。
 * - Pi 历史预算通过 `PiImageTranscoderPort` 调用这里，把旧图降采样而不是直接删除。
 * - BrowserScreenshot 等工具在产出时也走同一套压缩，避免“新图”单张就撞网关 body 上限。
 */

import { nativeImage } from 'electron'
import type { PiImageTranscoderPort } from '@profer/agent-provider-pi'
import {
  encodeModelImage,
  type ModelImageTranscodeOptions,
  type ModelImageSource,
  type ModelImageTranscodeResult,
} from './model-image-encode'

export interface ModelImageInput {
  data: string
  mimeType: string
}

/** 工具产出的“新图”统一档位：足够看清界面/文档，单张 base64 控制在 1.5MB 内。 */
export const TOOL_IMAGE_OPTIONS: ModelImageTranscodeOptions = {
  maxSide: 1600,
  quality: 82,
  maxBase64Bytes: 1_500_000,
}

/** 把工具截图压成模型可用的 JPEG；失败时回退原图，不阻断工具。 */
export function compressToolImageForModel(input: ModelImageInput): ModelImageInput {
  const result = transcodeImageForModel(input, TOOL_IMAGE_OPTIONS)
  return result ? { data: result.data, mimeType: result.mimeType } : input
}

export function transcodeImageForModel(
  input: ModelImageInput,
  options: ModelImageTranscodeOptions,
): ModelImageTranscodeResult | null {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(input.data, 'base64')) as unknown as ModelImageSource
    if (image.isEmpty()) return null

    // 已经是预算内的 JPEG 时直接复用，避免每轮请求重复编码造成画质逐轮下降。
    const size = image.getSize()
    if (
      input.mimeType === 'image/jpeg'
      && Math.max(size.width, size.height) <= options.maxSide
      && input.data.length <= options.maxBase64Bytes
    ) {
      return {
        data: input.data,
        mimeType: 'image/jpeg',
        width: size.width,
        height: size.height,
        bytes: Math.floor(input.data.length * 3 / 4),
      }
    }

    return encodeModelImage(image, options)
  } catch {
    return null
  }
}

/** Pi provider 的宿主转码端口：历史旧图降采样/转 JPEG。 */
export function createElectronPiImageTranscoder(): PiImageTranscoderPort {
  return {
    async transcode(input, options) {
      const result = transcodeImageForModel(input, options)
      return result ? { data: result.data, mimeType: result.mimeType } : null
    },
  }
}
