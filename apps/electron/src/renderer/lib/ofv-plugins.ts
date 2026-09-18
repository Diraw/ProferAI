/**
 * Open File Viewer 的插件白名单 —— 单一来源。
 *
 * 同时被两处使用：
 * - 渲染进程内的预览面 `components/file-browser/ofv-preview/OfvPreview.tsx`（回退路径）；
 * - 浏览器列里的独立 viewer 页 `viewer/main.ts`（主路径）。
 *
 * 为什么必须显式给插件：OFV 的 `createViewer` 实现是 `plugins = [...options.plugins || [], fallbackPlugin()]`，
 * 不传就只有 fallback 面板。而它的重依赖是**字面量动态 import**（three / mermaid / hls.js / ag-psd / xlsx /
 * pdfjs-dist / leaflet / prismjs 45 种语言…），Vite 会为它们全部生成异步 chunk ——
 * 白名单同时决定运行期加载与打包体积。
 *
 * 刻意不挂 `cadPlugin`：它的 `@mlightcad/*` 是可选 peer 依赖，本仓库未安装，挂上会在打开 dwg 时抛错。
 */
import {
  archivePlugin,
  assetPlugin,
  audioPlugin,
  drawingPlugin,
  emailPlugin,
  epubPlugin,
  gisPlugin,
  imagePlugin,
  model3dPlugin,
  ofdPlugin,
  officePlugin,
  textPlugin,
  videoPlugin,
  xmindPlugin,
  xpsPlugin,
  type PreviewPlugin,
} from '@open-file-viewer/core'

/** 顺序即匹配优先级：具体格式在前，`textPlugin` 作为文本兜底，`fallbackPlugin` 由 OFV 自动追加。 */
export function createOfvPlugins(): PreviewPlugin[] {
  return [
    officePlugin(), // docx / doc / xlsx / xls / pptx / ppt —— 老式 Office 是主要缺口
    ofdPlugin(),
    xpsPlugin(),
    epubPlugin(),
    emailPlugin(),
    archivePlugin(), // zip / 7z / rar / tar / gz…
    assetPlugin(),   // psd / psb / ai / eps / ps、字体（ttf/otf/woff）、wasm、sqlite/parquet/avro 等"资产"文件
    xmindPlugin(),
    drawingPlugin(),
    gisPlugin(),
    model3dPlugin(),
    audioPlugin(),
    videoPlugin(),
    imagePlugin(), // psd / ai / heic / tiff / ico…
    textPlugin(),
  ]
}
