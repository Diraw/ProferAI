# 验收门禁与交付

验收不以“源码有 token”或“构建成功”为完成标准。完成标准是：真实 Electron 窗口切换后，页面、输入框、设置页和 Windows 标题栏都按预期呈现。

## 0. 开工前

- 检查 `git status --short`，不覆盖无关未提交改动。
- 操作仓库为 Profer 源码根目录（含 `apps/electron`）。
- 先读取工作区 CLAUDE.md（若存在）。

## 1. 静态与构建（改了源码时）

在源码根目录中逐条执行，不要拼成含 `;` 的复合命令：

```bash
cd apps/electron && bunx tsc --noEmit
bun run build:renderer
bun run build:main
bun run build:preload
cd ../.. && git diff --check
```

- renderer 的 chunk-size 警告可接受，但必须检查退出码。
- 改了 `resources/skins/` 时还需 `bun run build:resources`，否则 dev 版读的是旧 dist 拷贝。
- 仅做用户皮肤（`~/.profer/skins/`）时不需要以上构建。

## 2. 产物断言（仅源码内置皮肤）

```bash
css=$(find apps/electron/dist/renderer/assets -name '*.css' | head -1)
grep -o '.skin-<id>' "$css" | head -1
```

皮肤 class 通过运行时注入，一般不会出现在 bundle 中。若出现旧 `theme-*` 残留，说明兼容层仍在。皮肤机制下 token 不进 bundle，验证重点是 `getSkinCss` 输出与真实运行时。

## 3. 运行时断言

时序陷阱：`class` 切换是同步的，皮肤 CSS 是异步 IPC 落地的。class 变化那一刻读到的 computed 值仍是上一个皮肤的。读取前要等 CSS 落地（渲染代码用 `whenSkinCssApplied(skinId)`），不要只靠 MutationObserver。

在开发版切换到目标皮肤，等待 CSS 注入完成后，打开 DevTools Console 执行：

```js
({
  classes: document.documentElement.className,
  background: getComputedStyle(document.documentElement).getPropertyValue('--background'),
  contentArea: getComputedStyle(document.documentElement).getPropertyValue('--content-area'),
  skinCssLoaded: !!document.getElementById('skin-css')?.textContent?.length,
})
```

必须确认：

1. `classes` 同时包含 `skin-<id>`；深色皮肤还包含 `dark`。
2. 两个 computed token 等于皮肤设计值，而不是 `.dark` 默认值。
3. `skinCssLoaded` 为 true。若 class 存在但 CSS 未注入，检查 applySkinCss 幂等短路是否误判。正常情况下首帧先有 class，IPC 返回后补注入。
4. 皮肤用到的 assets 在 Network 面板以 `profer-skin://` 加载成功（200）。
5. 肉眼检查主画布、侧栏、卡片、输入框、设置 Dialog、聊天正文。
6. 重启 Electron 后检查 Windows 标题栏。
7. 多窗口同步：开一个 Quick Task 窗口，在设置页删除当前皮肤，确认两个窗口都回退默认主题（`skins:changed` 广播生效）。
8. 若皮肤改了圆角语义，检查 `.rounded-lg` 与 `.rounded-full` 在真实窗口中的计算圆角；iframe 可视化中不能只依赖 `--radius` 字面值。

若 class 存在、stylesheet 也已加载，但 computed token 仍是默认 `.dark`：优先检查 skin.css 是否真的被 `getSkinCss` 读到，即磁盘缓存签名与格式版本是否失效。不要继续盲调色。

## 4. 交付措辞

- 只有静态或产物层面验证时，只能称“静态 / 产物层面已验证”。
- 没有真实窗口或 DevTools computed-style 证据时，不能称“皮肤已实现”。
- 不把“源码已改”“构建成功”“安装成功”表述为完成。

最终回复应列明：
- 新增或修改皮肤的名称与 id；
- 涉及的文件（皮肤包目录与源码改动）；
- 最终色板或 token 关键值；
- 临时探针或调试器是否已删除；
- 已执行的构建、产物与运行时验证；
- 未验证项（尤其是否需要重启主进程、标题栏是否已看过）。
