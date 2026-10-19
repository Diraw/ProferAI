import { describe, expect, test } from 'bun:test'
import { encodeModelImage, type ModelImageSource } from './model-image-encode'

function fakeImage(
  width: number,
  height: number,
  bytesFor: (quality: number, width: number, height: number) => number,
): ModelImageSource {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize({ width: nextWidth, height: nextHeight }) {
      return fakeImage(nextWidth, nextHeight, bytesFor)
    },
    toJPEG(quality: number) {
      return Buffer.alloc(bytesFor(quality, width, height))
    },
  }
}

describe('encodeModelImage', () => {
  test('按最长边等比缩放并输出 JPEG', () => {
    const image = fakeImage(3200, 1600, () => 500_000)

    const result = encodeModelImage(image, { maxSide: 1600, quality: 82, maxBase64Bytes: 1_500_000 })

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1600)
    expect(result!.height).toBe(800)
    expect(result!.bytes).toBe(500_000)
    expect(result!.mimeType).toBe('image/jpeg')
    expect(result!.data.length).toBe(Math.ceil(500_000 / 3) * 4)
  })

  test('超过 base64 预算时先逐级降低 JPEG 质量', () => {
    const qualities: number[] = []
    const image = fakeImage(1600, 900, (quality) => {
      qualities.push(quality)
      return quality <= 70 ? 100_000 : 2_000_000
    })

    const result = encodeModelImage(image, { maxSide: 1600, quality: 82, maxBase64Bytes: 200_000 })

    expect(result).not.toBeNull()
    expect(result!.bytes).toBe(100_000)
    expect(qualities[0]).toBe(82)
    expect(qualities).toContain(62)
  })

  test('质量降到下限仍超预算时继续缩小尺寸', () => {
    const image = fakeImage(1600, 800, (_quality, width, height) => width * height)

    const result = encodeModelImage(image, { maxSide: 1600, quality: 82, maxBase64Bytes: 1_200_000 })

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1280)
    expect(result!.height).toBe(640)
  })

  test('空图或编码异常返回 null，由调用方决定保留原图或省略', () => {
    expect(encodeModelImage({ ...fakeImage(10, 10, () => 1), isEmpty: () => true }, { maxSide: 1600, quality: 82, maxBase64Bytes: 1_000 })).toBeNull()
    expect(encodeModelImage({
      ...fakeImage(10, 10, () => 1),
      toJPEG: () => { throw new Error('boom') },
    }, { maxSide: 1600, quality: 82, maxBase64Bytes: 1_000 })).toBeNull()
  })
})
