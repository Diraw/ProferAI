/**
 * Node 专用 canvas（@napi-rs/canvas / canvas）在**浏览器构建**里的替身。
 *
 * 为什么需要：Open File Viewer 的 EMF 渲染路径（`emf-converter`）有一段**运行期守卫的可选 import**：
 *
 * ```js
 * nodeCanvasModule = await import('@napi-rs/canvas')   // 仅在既无 OffscreenCanvas 又无 document 时才会走到
 * ```
 *
 * 渲染进程里 OffscreenCanvas 与 document 都存在，所以这条路径永远不会执行；
 * 但 Vite 仍会在**构建期**解析它，而 `@napi-rs/canvas` 是原生 Node 包（内部 require `fs`/`https`/`stream`），
 * 会把浏览器构建直接打挂（实测报错：`Failed to resolve entry for package "https"`）。
 *
 * 因此这里给一个显式替身：构建期可解析；若真被调用则抛出可读错误，而不是静默返回 undefined
 * （静默返回会让 EMF 渲染变成"空白图"，比报错更难排查）。
 *
 * 由 vite.config.ts 的 resolve.alias 挂上（同时覆盖 `canvas`，pdfjs-dist 也引用同名可选依赖）。
 */
export function createCanvas(): never {
  throw new Error('渲染进程不应加载 Node canvas（@napi-rs/canvas）；请检查 vite.config.ts 的别名配置')
}

export const loadImage = createCanvas
export default { createCanvas, loadImage }
