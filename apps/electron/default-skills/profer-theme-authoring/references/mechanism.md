# 皮肤机制速览（改动前先读）

> 本文档描述 2026-08-08 重构后的皮肤包机制。旧机制（THEME_STYLES 白名单、Tailwind safelist、titlebar-overlay 硬编码、globals.css 的 theme-* token 块）已退役，仅平板 stub 回退层保留 theme-* 兼容。按旧文档执行会改错文件。

## 1. 皮肤包结构

皮肤包 = 一个目录，目录名即 id：

- `manifest.json`：id / name / tone(light|dark) / version / author / description / titlebar{color,symbolColor}
- `skin.css`：`:root` token 表 + 特例规则
- `preview.webp|png|svg`（可选）：设置页卡片预览
- `assets/`（可选）：背景图等

## 2. 位置

- 内置：`apps/electron/resources/skins/{id}/`。改后必须重跑 `bun run build:resources` 并重新构建才生效。
- 用户皮肤：`~/.profer/skins/{id}/`（开发版 `~/.profer-dev/skins/{id}/`，也可由 `PROFER_CONFIG_DIR` 覆盖）。刷新即生效，给用户做主题优先此处。
- 同名用户皮肤会被跳过，内置优先。

## 3. 加载与校验

- 主进程：`src/main/lib/skin-service.ts`（scanSkins / getSkinCss / handleProferSkinRequest）
- 安装校验：`src/main/lib/skin-manager-service.ts`
  - skin.css ≤ 512 KB
  - 整包 ≤ 5 MB
  - 单图 ≤ 4 MB
  - 禁止 `@import`、`@font-face`、data URL
  - assets 仅允许白名单图片格式
- token 未定义时继承 globals.css 默认值。

## 4. 资源协议

`skin.css` 中 `url("assets/xxx.webp")` 会被 `getSkinCss` 替换为 `profer-skin://<skinId>/assets/xxx.webp`。主进程按需读盘返回，不再 base64 内联，大图无 IPC 传输开销。

## 5. 运行时

- 标题栏颜色读 manifest.titlebar（主进程直接读 manifest，不是 CSS）。
- 注入：`skin-<id>` class + `<style id="skin-css">`。
- 性能：scanSkins 注册表进程级缓存；getSkinCss 磁盘缓存 `~/.profer/skin-cache/`（mtime 签名 + 格式版本 v2）；applySkinCss 幂等短路。
- 安装、删除、刷新经 `skins:changed` 广播到所有窗口。

## 6. 关键文件（开工前对比读取）

- `apps/electron/src/main/lib/skin-service.ts`
- `apps/electron/src/main/lib/skin-manager-service.ts`
- `apps/electron/src/renderer/atoms/theme.ts`：loadSkins / applySkinCss（幂等）/ applyThemeToDOM / tone 缓存 / handleSkinsChanged
- `apps/electron/src/renderer/index.html`：首帧防闪烁脚本（读 `profer-skin-tone` 推断 dark）
- `apps/electron/src/renderer/styles/skin-base.css`：公共组件规则，作用域为 `html[class*="skin-"]`
- `apps/electron/src/main/lib/titlebar-overlay.ts`：读 manifest.titlebar
- `apps/electron/src/main/ipc.ts`：SKIN_IPC_CHANNELS handler 与 `skins:changed` 广播
- 至少对比一个浅色、一个深色的既有皮肤包的 token 覆盖方式
- 完整架构与踩坑：工作区记忆 `workspace-files/.context/memory-archive/theme-token-plumbing.md`（注意：早期引用的 `skin-engine.md` 不存在）
- 参考实现：`apps/electron/resources/skins/mist-paper-dark/`、`apps/electron/resources/skin-template/`

把“已有皮肤现在碰巧工作”当作待验证事实，不当作自动保证。

## 7. 标题栏

皮肤在 `manifest.json` 的 `titlebar` 字段声明：`{ "color": "#172033", "symbolColor": "#f8fafc" }`。主进程 `resolveOverlayColors` 读取并同步窗口底色。改 manifest 后需刷新或重启；renderer HMR 不会重新加载主进程映射。

## 8. 目录与 manifest 示例

```
~/.profer/skins/my-skin/
├── manifest.json     # 必填：id(kebab-case，与目录名一致)/name/tone(light|dark)
│                     # 可选：version/author/description/titlebar{color,symbolColor}/previewScale/previewPosition/tooltip
├── skin.css          # 必填：:root token 表 + 特例规则（≤512KB）
├── preview.webp|png|svg  # 可选
└── assets/           # 可选：webp/png/svg/jpg/jpeg，单张 ≤4MB
```

## 9. 缩略图

缩略图在包根目录 `preview.<ext>`（不是 assets/，≤2 MB），查找顺序 `.webp → .png → .svg → .jpg → .jpeg`，取首个命中。`create_skin` 未传 `previewPath` 时会从壁纸派生 `preview.jpg`；传 `previewScale`(>0) / `previewPosition` 可调卡片取景。预览缓存按文件 mtime+size 失效，手工补图后刷新即可。

## 10. create_skin 工具

Agent 创建皮肤优先用 `create_skin`。它会自行复制壁纸进 `assets/`、做 manifest/CSS/大小校验、原子安装并刷新皮肤库。结果中的 `installedPath` 即确定安装位置（如 `~/.profer-dev/skins/<id>`）。安装后不要再用 find 或路径猜测做二次定位。
