/**
 * @profer/ui - 共享 UI 组件和 Hooks
 */

export { Toaster } from './primitives/sonner.tsx'
export { MarkdownPreview, MARKDOWN_PREVIEW_LIGHT_COMPONENTS } from './markdown-preview.tsx'
export type { MarkdownPreviewProps } from './markdown-preview.tsx'
export { CodeBlock } from './code-block/index.ts'
export { MermaidBlock } from './mermaid-block/index.ts'
export { useSmoothStream } from './hooks/index.ts'
export { useSmoothZoom } from './hooks/use-smooth-zoom.ts'
export type { SmoothZoom, SmoothZoomOptions } from './hooks/use-smooth-zoom.ts'
export { applyWheelZoom, DEFAULT_WHEEL_ZOOM } from './lib/wheel-zoom.ts'
export type { WheelZoomOptions } from './lib/wheel-zoom.ts'
export { cn } from './lib/cn.ts'
export { detectIsMac, detectIsWindows } from './lib/platform.ts'
export {
  isMermaidLanguage,
  looksLikeMermaidDefinition,
  shouldInspectMermaidCodeBlock,
  shouldRenderMermaidCodeBlock,
} from './mermaid-detection.ts'
