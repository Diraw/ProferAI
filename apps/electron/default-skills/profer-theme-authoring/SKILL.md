---
name: profer-theme-authoring
description: Profer 皮肤（皮肤包）的元提示词：负责判断皮肤任务类型、选择落地方式、约束设计与验收，并按需路由到机制、CSS 配方、验收清单。用户要求新增/修改/复刻/优化 Profer 皮肤、特殊风格、暗色或浅色配色、皮肤预览、皮肤 token、标题栏配色，或反馈“皮肤没生效/看起来仍是默认色/设置页或输入框不跟随皮肤/换肤后加载变慢/多窗口皮肤不同步”时使用。
compatibility: 修改内置皮肤源码时需要 read/edit/bash 访问 Profer 源码仓库（apps/electron）；仅做用户皮肤时只需 create_skin 或对用户皮肤目录的读写。
version: "1.0.0"
---

# Profer 皮肤元提示词

你的职责是把用户的皮肤需求变成**可安装、可验证**的皮肤包，并如实报告验证到哪一步。本文件只定义判断、路由和硬约束；机制细节、CSS 配方、验收清单在 `references/` 中，需要时再读。

## 1. 先判定任务类型

| 类型 | 做法 | 风险 |
|---|---|---|
| 新增皮肤 | 设计 token → 落地 → 完整验收 | 中 |
| 调已有用户皮肤 | 只改用户皮肤目录内文件，验收窗口与标题栏 | 低 |
| 改原生浅色 / 深色 | 默认不用皮肤 token 覆盖 `:root` 或 `.dark`；先说明影响面并获得明确确认 | 高 |
| 只改预览图 | 验证卡片资源与布局，不宣称视觉已验证 | 低 |

若用户给了色板或截图，以其为视觉基准，不擅自替换为“更好看”的方案。

## 2. 按需取证，不凭记忆

- 机制、限制、安装位置、标题栏、缓存：读 `references/mechanism.md`。涉及“换肤后颜色不跟随”或读取 token 的渲染代码：另读工作区记忆 `workspace-files/.context/memory-archive/theme-token-plumbing.md`。
- 写 `skin.css`、选择器、特例规则：读 `references/css-recipes.md`。
- 验收、运行时断言、交付措辞：读 `references/verification.md`。
- 参考 token 写法：只读 `apps/electron/resources/skins/mist-paper-dark/`（仓库内置参考）或用户皮肤目录 `~/.profer/skins/`（开发版 `~/.profer-dev/skins/`）这两个固定位置。
- **禁止**用 `find`、`ls -R`、`Get-ChildItem -Recurse`、`dir /s` 等递归或全盘扫描定位皮肤目录；这会遍历 `~/Music` 等受保护目录并触发 macOS 隐私弹窗。`create_skin` 返回的 `installedPath` 就是确定位置。

## 3. 落地方式

- **默认用 `create_skin`**：传入 `id`、`name`、`tone`(light|dark)、`skinCss`；有已授权壁纸时传 `wallpaperPath`，有缩略图需求时传 `previewPath`，取景用 `previewScale` / `previewPosition`，标题栏用 `titlebarColor` / `titlebarSymbolColor`。它负责复制壁纸进 `assets/`、校验、原子安装并刷新皮肤库。
- **只调用户皮肤**：直接编辑 `~/.profer/skins/{id}/` 内文件，在设置页刷新即可。
- **改内置皮肤**：需改 `apps/electron/resources/skins/{id}/`，并重跑 `bun run build:resources` 与重新构建。这是高成本路径，除非用户明确要求，否则优先做用户皮肤。
- 同名用户皮肤会被内置皮肤覆盖跳过；换 id 或确认内置冲突后再安装。
- 单张 assets 图片不得超过 4 MB，整包不得超过 5 MB；生成图过大时先用系统已有图片工具压缩或转换，再安装。
- 只有用户明确要求覆盖已有皮肤时才传 `replace: true`。

## 4. 设计硬约束

- **按层级设计**：主画布、应用框架、卡片、输入区、浮层、文字、品牌状态各有分工。不要用“整体调灰”代替层级，暗色皮肤至少让主画布、框架、卡片、输入区、弹窗可辨。
- **文字对比**：正文与背景至少 4.5:1；低对比艺术风格需说明可读性取舍。
- **不覆盖原生**：不在皮肤里改动原生浅色 / 深色的全局 token，除非是第 1 节的高风险任务并已确认。
- **资源安全**：`url()` 只用 `assets/` 相对路径，文件名小写；禁止 `data:`、`file:`、外链、绝对路径、`../`，也不引用会话输出目录。壁纸规则写在 `.shell-bg` 上即可。
- **先验链路再调色**：若皮肤看起来像默认深色，先用高对比探针确认 renderer 确实接受了皮肤 token；探针确认后立即撤回，不留在正式皮肤中。
- 不把“仅改灰度”当作完成；让用户看真实窗口后，再决定更浅、更暖或更冷。

## 5. 验收与交付

- 验收按 `references/verification.md` 执行。只有静态校验或构建通过时，只能称“静态 / 产物层面已验证”。
- 不把“源码已改”“构建成功”或“安装成功”说成“皮肤已实现”。
- 最终回复列明：皮肤名称与 id；涉及的文件（皮肤包目录与源码改动）；关键色板或 token；探针是否已撤回；已执行的构建与运行时验证；未验证项（例如是否需要重启主进程、标题栏是否已看过）。
