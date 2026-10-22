# 皮肤机制速览（改动前先读）

> 本文档描述 2026-08-08 重构后的皮肤包机制。旧机制（THEME_STYLES 白名单、Tailwind safelist、titlebar-overlay 硬编码、globals.css 的 theme-* token 块）已退役，仅平板 stub 回退层保留 theme-* 兼容。按旧文档执行会改错文件。

## 1. 皮肤包结构

皮肤包 = 一个目录，目录名即 id：

- `manifest.json`：id / name / tone(light|dark) / version / author / description / titlebar{color,symbolColor} / contractVersion
- `skin.css`：`:root` token 表 + 特例规则
- `preview.webp|png|svg`（可选）：设置页卡片预览
- `assets/`（可选）：背景图等

**契约版本**：`create_skin` 一律写入 `contractVersion: 2`；安装层不把版本当门槛（v1 始终可加载），但 v2 声明意味着皮肤应当覆盖 Surface Contract v2 的语义表面。只写 v1 token 的皮肤会在 v2 表面上继承 `.dark` 默认值。完整 token 清单见 `resources/skin-template/skin.css`，它是产品内唯一真源。

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
  - `url()` 与 `src()` 走同一白名单：参数必须是 `assets/` 下小写 png/webp/svg/jpg/jpeg，且不得含 CSS 转义
  - 字符串不得跨行或未闭合，否则安装与运行时读取都会拒绝
  - assets 仅允许白名单图片格式
- token 未定义时继承 globals.css 默认值；但 `skin-base.css` 消费的可选 token（选中态、滚动条等）在 globals 里没有默认值，不定义就整条规则失效。

## 4. 资源协议

`skin.css` 中 `url("assets/xxx.webp")` 会被 `getSkinCss` 替换为 `profer-skin://<skinId>/assets/xxx.webp`。主进程按需读盘返回，不再 base64 内联，大图无 IPC 传输开销。

## 5. 运行时

- 标题栏颜色读 manifest.titlebar（主进程直接读 manifest，不是 CSS）。
- 注入：`skin-<id>` class + `<style id="skin-css">`。
- 性能：scanSkins 注册表进程级缓存；getSkinCss 磁盘缓存 `~/.profer/skin-cache/`（mtime 签名 + 格式版本 v2）；applySkinCss 幂等短路。
- 安装、删除、刷新经 `skins:changed` 广播到所有窗口。

## 6. 关键文件（开工前对比读取）

- `apps/electron/resources/skin-template/skin.css` + `manifest.json`：**唯一契约真源**，设置页“制作指南”直接 import 这两个文件
- `apps/electron/src/renderer/styles/skin-base.css`：公共组件规则，作用域 `html[class*="skin-"]`，列出皮肤可选 token 的真实消费点
- `apps/electron/tailwind.config.js`：token → class 映射，判断某个 token 到底影响哪些组件
- `apps/electron/src/renderer/styles/globals.css`：`:root` / `.dark` 默认值，判断“没写会继承成什么”
- `apps/electron/src/main/lib/skin-service.ts`：scanSkins / getSkinCss / auditSkinCss / 资源协议
- `apps/electron/src/main/lib/skin-manager-service.ts`：安装校验、包大小、manifest 字段
- `apps/electron/src/renderer/atoms/theme.ts`：loadSkins / applySkinCss（幂等）/ applyThemeToDOM / tone 缓存 / handleSkinsChanged
- `apps/electron/src/renderer/index.html`：首帧防闪烁脚本（读 `profer-skin-tone` 推断 dark）
- `apps/electron/src/main/lib/titlebar-overlay.ts`：读 manifest.titlebar；平台差异见 §7
- `apps/electron/src/main/ipc.ts`：SKIN_IPC_CHANNELS handler 与 `skins:changed` 广播
- 至少对比一个浅色、一个深色的既有皮肤包（如 `forest-light` / `forest-dark`）看真实层级差异；注意所有内置皮肤的 v2 段都是把 v2 映射到既有 v1 色板的兼容写法（`--shell-surface: var(--background)`），不要当契约模板抄；直接赋值 v2 表面的只有 `resources/skin-template/skin.css`
- 完整架构与踩坑：工作区记忆 `workspace-files/.context/memory-archive/theme-token-plumbing.md`（注意：早期引用的 `skin-engine.md` 不存在）

把“已有皮肤现在碰巧工作”当作待验证事实，不当作自动保证。

## 7. 标题栏

皮肤在 `manifest.json` 的 `titlebar` 字段声明：`{ "color": "#172033", "symbolColor": "#f8fafc" }`。

- **Windows**：`updateWindowFrameAppearance` 调 `setTitleBarOverlay`，切皮肤后实时更新窗口底色与符号色。
- **macOS**：同一函数在非 win32 直接早退；`manifest.titlebar.color` 只在窗口创建时经 `getWindowFrameColor()` 作为 `backgroundColor` 生效。切皮肤后标题栏/窗口底色可能不更新，需要重启窗口才能看到。
- 因此：Windows 上可以验收 overlay；macOS 上不要承诺“切肤即时生效”，也不要拿 macOS 的表现否定 manifest 配置。
- 改 manifest 后需刷新或重启；renderer HMR 不会重新加载主进程映射。

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

Agent 创建皮肤优先用 `create_skin`。它会自行复制壁纸进 `assets/`、做 manifest/CSS/大小校验、原子安装并刷新皮肤库。

- 写入 `contractVersion: 2`；不要手工改 manifest 版本字段来“降级”。
- `apply` 默认 `true`；只有用户明确要求“安装但不启用”时才传 `false`。
- `replace` 只在用户明确要求覆盖时传 `true`；同名内置皮肤仍会优先，不能覆盖。
- 结果中的 `installedPath` 即确定安装位置（如 `~/.profer-dev/skins/<id>`）。安装后不要再用 find 或路径猜测做二次定位。
