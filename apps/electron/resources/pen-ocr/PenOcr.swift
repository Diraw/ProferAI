import AppKit
import Foundation
import Vision

// pen-ocr — 用 macOS Vision 把手写图片识别成文字
//
// 用法：pen-ocr <image-path> [lang,lang]
// 输出：stdout 打印识别文本（按行拼接）；失败时退出码非 0，stderr 打印原因。
//
// 说明：
// - recognitionLevel 用 accurate，关掉 usesLanguageCorrection：手写场景下语言纠错
//   会把形近字改成常见词，反而更错。
// - 语言顺序决定优先级，中文在前。

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write("pen-ocr: \(message)\n".data(using: .utf8)!)
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: pen-ocr <image-path> [lang,lang]", code: 2)
}

let imagePath = arguments[1]
guard let image = NSImage(contentsOfFile: imagePath) else {
    fail("cannot read image at \(imagePath)", code: 3)
}
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    fail("cannot decode image", code: 4)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = arguments.count >= 3
    ? arguments[2].split(separator: ",").map(String.init)
    : ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision failed: \(error.localizedDescription)", code: 5)
}

let observations = request.results ?? []
let lines = observations.compactMap { observation -> String? in
    observation.topCandidates(1).first?.string
}
print(lines.joined(separator: "\n"))
