# 层级与失效模式（皮肤出问题时先读这一篇）

> 本文回答的是「为什么 token 写了却没效果 / 一改就坏」。
> 契约真源仍是 `apps/electron/resources/skin-template/skin.css`；本文只解释它的消费方式与级联关系。
> 文中的源码事实以 2026-10-24 的 `profer-main` 为准；源码变化后先复核再引用。

皮肤不是一个平面配色表，而是**五层叠加**：

1. **窗口层**：`BrowserWindow` 的 `backgroundColor`、`transparent`、macOS `vibrancy`。
2. **文档层**：`html` / `body` / `#root` 的底色，以及 `html` 上的 `skin-*`、`dark`、`ui-classic` 类。
3. **表面层**：外壳、侧栏、主画布、卡片、输入、浮层各自吃哪个 token。
4. **状态层**：hover / selected / running / blocked / completed / disabled，以及滚动条、选区、焦点环。
5. **独立渲染面**：iframe 片段、图表渲染器、OFV 文件预览、导出页——它们**不继承**主文档的皮肤规则。

任何一层处理错，症状都可能表现为「按钮没样式」「会话没颜色」「透明底做不到」。先定位层，再改值。

## 1. 值格式层级：三元组还是完整值

这是最高频的翻车点，而且两种错法都会让属性**变成透明/无效**，看起来就像「样式丢了」。

### 1.1 Tailwind 映射组：只写 HSL 三元组

`tailwind.config.js` 把这些 token 编译成 `hsl(var(--token) / <alpha-value>)`，所以值必须是纯 `H S% L%`，**不能带 `/ alpha`**，也不能是 `#hex`、`rgb()` 或再包一层 `hsl()`。透明度由类名上的 `/ 70` 这类修饰符提供，不是写进 token。

```css
/* 对 */
--primary: 212 85% 61%;
--border: 220 18% 25%;
```

```css
/* 错：hsl(hsl(...)) / hsl(#3b82f6) / hsl(... / 0.6 / 1) 都是非法值 */
--primary: hsl(212 85% 61%);
--primary: #3b82f6;
--border: 220 18% 25% / 0.6;
```

后果：`bg-primary`、`text-primary-foreground`、`border-border` 这些工具类的声明在计算值阶段失效，背景回落为透明、文字回落为继承色。典型观感就是「主按钮变成一行裸文字」「边框全没了」。

属于这一组的代表：`--background`、`--foreground`、`--card`、`--card-foreground`、`--popover`、`--popover-foreground`、`--dialog`、`--dialog-foreground`、`--primary`、`--primary-foreground`、`--secondary`、`--secondary-foreground`、`--accent`、`--accent-foreground`、`--muted`、`--muted-foreground`、`--border`、`--input`、`--ring`、`--destructive`、`--destructive-foreground`、`--content-area`、`--sidebar-surface`、`--tabbar-surface`、`--tab-surface`、`--shell-surface`、`--raised-surface`、`--sunken-surface`、`--surface-border`、`--surface-border-strong`、`--control-surface`、`--control-hover`、`--input-surface`、`--input-hover`、`--selected-surface`、`--focus-ring`、`--overlay`、`--overlay-foreground`、`--message-surface`、`--message-user-surface`、`--code-bg`、`--code-fg`、`--blockquote-surface`、`--table-header-surface`、`--browser-host-surface`、`--tooltip`、`--tooltip-foreground`、`--tooltip-muted`、`--success`、`--success-foreground`、`--warning`、`--warning-foreground`、`--info`、`--info-foreground`、`--chart-1..8`。

这份清单以 `tailwind.config.js` 的实际映射为准（35 个带 `<alpha-value>`，18 个是 `hsl(var(--x))`，都不带 alpha）。**唯一允许 token 里带 alpha 的是 §1.2.1 的第三类**；其余一律把透明度写在类名修饰符上（`bg-overlay/40`、`border-surface-border/60`）。

### 1.2 skin-base 直连组：必须写完整 CSS 值

`skin-base.css` 的写法是 `background: var(--x)`、`box-shadow: var(--x)`、`stroke: var(--x)`，**没有 `hsl()` 包装，也没有 fallback**。所以这里必须写完整颜色/阴影/渐变。

```css
/* 对 */
--item-selected-bg: hsl(150 12% 22%);
--item-selected-fg: hsl(145 35% 65%);
--mode-slider-bg: hsl(150 18% 28%);
--scroll-thumb-bg: hsl(145 25% 45% / 0.20);
--selection-bg: hsl(var(--accent-foreground) / 0.75);
--shell-bg-gradient: linear-gradient(135deg, hsl(150 10% 5%), hsl(150 10% 7%));
--dialog-glow-shadow: 0 0 40px 8px rgb(255 255 255 / 0.06), 0 25px 50px -12px rgb(0 0 0 / 0.5);
--code-block-header-bg: rgb(34 42 37);
```

```css
/* 错：三元组直接塞给 background，声明无效 */
--item-selected-bg: 150 12% 22%;
```

后果：`.session-item-selected` 的 `background: var(--item-selected-bg) !important` 在计算值阶段失效，背景变成 **transparent**；而它带 `!important`，会把组件原本的 `bg-foreground/[0.07]` 一起顶掉。于是「选中会话完全看不出选中」。

这一组包括：`--item-selected-bg`、`--item-selected-fg`、`--selection-bg`、`--selection-color`、`--mode-slider-bg`、`--mode-slider-shadow`、`--mode-btn-selected-color`、`--workspace-badge-color`、`--dialog-glow-shadow`、`--code-block-header-bg`、`--minimap-indicator-bg`、`--scroll-thumb-bg`、`--scroll-thumb-hover`、`--scroll-thumb-active`、`--plan-mode-stroke-color`、`--tabbar-shadow-color`、`--shell-bg-gradient`。

### 1.2.1 第三类：`hsl(var(--x))` 消费的三元组（alpha 合法）

有一小组 token 没有 Tailwind 映射，消费方自己包一层 `hsl()`：

| token | 消费点 | 写法 |
|---|---|---|
| `--diff-addition-bg` / `--diff-deletion-bg` | `DiffView.tsx` 的 `hsl(var(--diff-*-bg))` | `H S% L% / 0.14` 或纯三元组 |
| `--diff-addition-fg` / `--diff-deletion-fg` | 同上，以及行号文字色 | 三元组 |
| `--tiptap-pre-bg` | `skin-base.css` 的 `hsl(var(--tiptap-pre-bg, var(--code-bg)))` | 三元组 |

这一类写 `H S% L%` 或 `H S% L% / alpha` 都合法，因为外面只包一层 `hsl()`，不会拼成 `hsl(... / a / 1)`。`globals.css` 的默认值本身就是带 alpha 的（`--diff-addition-bg: 142 71% 45% / 0.12`）。看到这一类带 alpha 不要“修”成纯三元组，那会把 12% 的淡色底变成实心色块。

### 1.3 派生组：只引用其他 token

`--workspace-canvas`、`--panel-surface`、`--panel-border` 由 `skin-base.css` 在 `html[class*="skin-"]` 上定义，分别指向 `--sunken-surface`、`--raised-surface`、`--surface-border`。它们主要给 OFV 文件预览与可视化宿主用，**不是主界面的表面 token**；不要在这里写死颜色，否则会绕开皮肤自己的层级。

### 1.4 一条命令自查格式

```bash
# Tailwind 组写成 #hex / rgb() / hsl() 是错的
grep -nE '^\s*--(background|foreground|card|card-foreground|popover|popover-foreground|dialog|dialog-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|muted|muted-foreground|border|input|ring|destructive|destructive-foreground|content-area|sidebar-surface|tabbar-surface|tab-surface|shell-surface|raised-surface|sunken-surface|surface-border|surface-border-strong|control-surface|control-hover|input-surface|input-hover|selected-surface|focus-ring|overlay|overlay-foreground|message-surface|message-user-surface|code-bg|code-fg|blockquote-surface|table-header-surface|browser-host-surface|tooltip|tooltip-foreground|tooltip-muted|success|success-foreground|warning|warning-foreground|info|info-foreground|chart-[1-8]):\s*(#|rgb|hsl)' skin.css

# 直连组写成裸三元组是错的（只匹配 H S% L%，不误伤 0 2px 4px 这类阴影值）
grep -nE '^\s*--(item-selected-bg|item-selected-fg|selection-bg|selection-color|mode-slider-bg|mode-btn-selected-color|workspace-badge-color|code-block-header-bg|minimap-indicator-bg|scroll-thumb-bg|scroll-thumb-hover|scroll-thumb-active|plan-mode-stroke-color|shell-bg-gradient):\s*[0-9.]+(\.[0-9]+)?\s+[0-9.]+%' skin.css

# Tailwind 组不能把 alpha 写进 token（会拼成 hsl(... / a / 1)）
grep -nE '^\s*--(background|foreground|card|card-foreground|popover|popover-foreground|dialog|dialog-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|muted|muted-foreground|border|input|ring|destructive|destructive-foreground|content-area|sidebar-surface|tabbar-surface|tab-surface|shell-surface|raised-surface|sunken-surface|surface-border|surface-border-strong|control-surface|control-hover|input-surface|input-hover|selected-surface|focus-ring|overlay|overlay-foreground|message-surface|message-user-surface|code-bg|code-fg|blockquote-surface|table-header-surface|browser-host-surface|tooltip|tooltip-foreground|tooltip-muted|success|success-foreground|warning|warning-foreground|info|info-foreground|chart-[1-8]):[^;]*/[^;]*;' skin.css
```

三条都应为空。`grep` 只是粗筛，最终以真实窗口的 computed style 为准。

## 2. 未定义 ≠ 回退默认值

旧文档写过「token 未定义时声明失效，组件回落 Tailwind 基础样式」。这句话对 **skin-base 的直连组是错的**，而且错得很危险。

CSS 规则是：`var(--x)` 未定义且没有 fallback 时，该声明在计算值阶段变成 **guaranteed-invalid**，属性按 `unset` 处理（多数情况 = initial = 透明 / 无阴影 / 无描边），**不会**把级联里更早的声明重新捡回来。

已在 Chromium（Electron 渲染器同源）用最小页面验证：

```html
<style>
  .row { background-color: rgb(255, 0, 0); }
  html[class*="skin-"] .row { background-color: var(--item-selected-bg) !important; }
</style>
<div class="row">x</div>
```

`html` 带 `skin-test`、未定义 `--item-selected-bg` 时，`.row` 的 computed `background-color` 是 `rgba(0, 0, 0, 0)`，不是红色。

推论：

- `.session-item-selected` / `.workspace-item-selected` / `.tab-item-selected` 未定义 `--item-selected-bg` → **没有选中底色**。
- `.mode-slider` 未定义 `--mode-slider-bg` → 模式切换器的滑块**消失**。
- `.scroll-progress-thumb` 未定义 `--scroll-thumb-bg` → 滚动进度条**消失**。
- `::selection` 未定义 `--selection-bg` → 选区没有底色。
- `[data-radix-dialog-content]` 未定义 `--dialog-glow-shadow` → 光晕消失（这条通常无害）。
- `.shell-bg` 未定义 `--shell-bg-gradient` → `background` 简写失效 → **外壳变透明**，缝隙露出 `body` 的 `--background`，而不是 `--shell-surface`。

所以：**要么给直连组全部赋值，要么在皮肤里用自己的规则覆盖掉整条声明**；不能指望「不写就会自动回落」。

有 fallback 的只有三个：`--minimap-indicator-bg`（回落前景色）、`--tiptap-pre-bg`（回落 `--code-bg`）、`--plan-mode-stroke-color`（回落 primary/45%）。

## 3. 级联层级：后写不一定赢

注入顺序是 `globals.css` → `skin-base.css` → `<style id="skin-css">`（运行时 append 到 `head` 末尾）。同特异性时后者赢；但**特异性更高时，顺序救不了你**。

| 选择器 | 特异性 | 影响 |
|---|---|---|
| `:root` | (0,1,0) | 皮肤的 token 表 |
| `:root.ui-classic` | (0,2,0) | 经典界面的 `--radius` 等；会压过皮肤 `:root` |
| `:where(html[class*="skin-"]) .shell-bg` | (0,1,0) | `:where()` 清零，只靠顺序赢 `.bg-surface-shell` |
| `html[class*="skin-"] .session-item-selected` | (0,2,1) | 带 `!important`，压过组件工具类 |
| `.ui-classic .agent-input-surface` | (0,2,0) | 带 `!important`，压过皮肤裸 `.agent-input-surface` |
| `.dark .topbar-editorial .topbar-tab-inactive.topbar-tab-status-running` | (0,4,0) | 深色顶栏状态边框，硬编码色 |
| `[class*="rounded"]` | (0,1,0) | 直角 catch-all，只作用于主文档 |

实践规则：

- 皮肤规则统一加 `html[class*="skin-"]` 前缀，避免和 `:root.ui-classic`、`.dark`、`.ui-classic` 打架。
- 需要压过经典界面规则时，用 `html[class*="skin-"].ui-classic ...`，不要只写 `.ui-classic ...`（同特异性时你赢，但遇到 `.ui-classic.theme-*` 就输）。
- 需要压过 `!important` 时，选择器必须**同时**更高特异性 + `!important`；只加 `!important` 不够。
- 不要靠「皮肤 CSS 后注入」去赌 Vite dev 的样式注入顺序；生产环境成立，开发期 HMR 不保证。

### 3.1 经典界面（ui-classic）会换承载者

同一块表面在两种界面下可能由不同 token 承载：

| 表面 | 现代界面 | 经典界面 |
|---|---|---|
| 顶栏 | `.tabbar-bg` 透明，跟随所在 Panel 的 `bg-content-area` | `.ui-classic .tabbar-bg { background: hsl(var(--muted) / 0.5) }` |
| 输入区 | `.agent-input-surface { background: hsl(var(--input-surface)) !important }` | `.ui-classic .agent-input-surface { background: hsl(var(--background) / 0.7) !important }` |
| 模式切换轨道 | `bg-primary/5` | `.ui-classic .mode-switcher-track { background: hsl(var(--muted)) !important }` |
| 侧栏 | `bg-sidebar`（`--sidebar-surface`） | 同左 |

所以「现代界面看着对，切到经典界面输入框变回主背景色」不是皮肤没生效，而是被经典界面的高特异性规则覆盖了。修法是同特异性覆盖：

```css
html[class*="skin-"].ui-classic .agent-input-surface {
  background-color: hsl(var(--input-surface)) !important;
}
```

### 3.2 合成层与 z-index

AppShell 的层级大致是：`.shell-bg`（0）→ 主区 `z-60` → 侧栏 `z-70` → 侧栏拖拽把手 `z-80` → 顶部拖拽条 `z-50`（fixed）→ Dialog `z-100` → 右键菜单 `z-9999`。

- 给 `html` / `body` / `#root` / `.shell-bg` 加 `transform`、`filter`、`backdrop-filter`、`perspective` 会创建新的 containing block，`position: fixed` 的 Dialog 会相对它定位，表现为「弹窗偏移 / 被裁切」。
- `backdrop-filter` 还会创建合成层，Electron 的 `-webkit-app-region: drag` 命中在合成层上不稳定；AppShell 的注释已经记录过「皮肤给 TabBar 加 backdrop-filter 后 Tab 被误判为拖拽区」。
- 壁纸、渐变、模糊尽量只落在 `.shell-bg` 的 `background` 上；不要给外壳加 `filter: blur()`。

### 3.3 `tone` 决定 `dark` 类，不只是预览标签

`manifest.tone` 会驱动 `html.dark`：`dark` 皮肤加类，`light` 皮肤移除类。很多组件和 `globals.css` 规则依赖 `.dark`（阴影、`dark:` 变体、滚动条、部分边框），所以：

- 深色色板却声明 `tone: light` → 失去深色阴影/深色变体，界面会“颜色对但质感不对”。
- 浅色色板却声明 `tone: dark` → 拿到深色阴影与深色滚动条，浅色卡片会发脏。
- 皮肤 id 以 `-light` 结尾时，注册表就绪前会被启发式判为浅色；其余 id 默认按深色推断。深色皮肤不要用 `-light` 结尾，浅色皮肤最好用 `-light` 结尾，避免首帧闪烁。

`tone` 与 `:root` 里的色板必须一致；这是 manifest 层级的约束，不是 CSS 能补救的。

## 4. token 名 ≠ 它真正管的东西

这张表按源码里的真实消费点整理，专治「改了没反应」。

| token | 看起来管什么 | 实际管什么 / 陷阱 |
|---|---|---|
| `--background` | 整个应用底色 | `body` + 94 处 `bg-background`；**不是主画布**，主画布是 `--content-area` |
| `--content-area` | 内容区 | `MainArea` 的 Panel + 36 处；改它才改对话区 |
| `--sidebar-surface` | 侧栏 | `LeftSidebar` 的 `bg-sidebar`（4 处） |
| `--shell-surface` | 外壳 | `AppShell` 根节点 `bg-surface-shell`（1 处） |
| `--card` | 卡片 | 设置卡片、订阅卡等 19 处 `bg-card` |
| `--raised-surface` | 抬升面 | 面板、插件视口 25 处 `bg-surface-raised`；和 `--card` 不是同一个东西 |
| `--sunken-surface` | 下沉面 | 代码块、缩略图底 10 处 `bg-surface-sunken` |
| `--input` | 输入框边框 | **当前没有消费点**：`tailwind.config.js` 里 `input` 键被后面的对象覆盖，`bg-input` / `border-input` 实际读 `--input-surface` |
| `--input-surface` | 输入框背景 | 输入框背景 + `border-input` 边框 + 经典界面覆盖的基准 |
| `--control-surface` / `--control-hover` | 控件 | `secondary` / `outline` 按钮的背景与 hover；**没有 `--control-foreground`** |
| `--secondary` | 次级按钮 | 12 处 `bg-secondary`；**secondary 按钮用的是 `--control-surface`**，不是它 |
| `--secondary-foreground` | 次级文字 | secondary 按钮的文字色；它和 `--secondary` 不必是同一套对比关系 |
| `--accent` | 强调色 | 98 处；ghost 按钮 hover、列表 hover 等；**不是 accent 按钮** |
| `--tabbar-surface` | 顶栏 | 只用于 `.window-controls`（Windows 右上角窗口控制按钮组）的底；`.tabbar-bg` 本身是 `transparent`，整条顶栏跟随 Panel 的 `--content-area`。改它不会改顶栏 |
| `--tab-surface` | Tab 背景 | 双重语义：`TabGroupItem` 里当背景；`topbar-editorial` 选中态里当**文字色**（反色内容） |
| `--selected-surface` | 选中面 | 设置/规划页的选中项 8 处；`--selected-foreground` 当前没有映射，是死 token |
| `--message-surface` | 消息卡片 | **不会自动生效**；必须自己写 `.message-item.is-assistant` 规则 |
| `--success` / `--warning` / `--info` | 状态色 | 会话状态点、左侧 3px 条、委托图标、Goal 状态；顶栏 Tab 状态边框仍是硬编码色 |
| `--chart-1..8` | 图表 | 原生图表 + 导出页；不影响界面其他部分 |
| `--workspace-canvas` / `--panel-surface` / `--panel-border` | 工作区/面板 | OFV 预览、可视化宿主、导出；主界面没有 `bg-workspace-canvas` 之类的类 |

结论：改一个表面之前，先确认它属于哪一行；不要连续调 `--background` 碰运气。

补充：`--overlay-foreground` 目前也没有 Tailwind 映射（只有 `bg-overlay`，没有 `text-overlay-foreground`），和 `--selected-foreground` 一样属于契约里的预留 token；写了不会改变现有界面，但保留它不影响安装。

## 5. 症状 → 根因 → 修法

### 5.1 按钮 / 分段控件「样式丢失」

按概率排序：

1. **值格式错**：`--primary`、`--control-surface`、`--secondary-foreground` 写成 `#hex` 或 `hsl(...)` → 背景/文字声明失效。用 §1.4 的 grep 自查。
2. **对比层级塌陷**：`--control-surface` 与 `--background` 同色、`--surface-border` 与背景同色 → outline/secondary 按钮的边界消失，看起来像没样式。
3. **缺 hover**：只写 `--control-surface` 不写 `--control-hover`，hover 回落到 `.dark` 默认灰，和皮肤色板脱节。
4. **文字色错配**：secondary 按钮文字吃 `--secondary-foreground`；把它设成浅色（为浅色 `--secondary` 配的）会让深色 `--control-surface` 上的字看不见。
5. **滑块消失**：模式切换器 `.mode-slider` 吃 `--mode-slider-bg`（完整值）；不写或写成三元组 → 透明滑块。
6. **元素级重置**：皮肤里写 `button { background: ... }`、`* { color: ... }` 会无差别压掉变体；皮肤只应赋值 token + 少量具名特例。
7. **直角 catch-all 误伤**：`[class*="rounded"] { border-radius: 0 !important }` 只改形状，不改颜色；如果按钮看起来「只剩文字」，先查颜色格式，不要怪圆角。

按钮变体的真实依赖：

| variant | 背景 | 文字 | hover | 边框/阴影 |
|---|---|---|---|---|
| `default` | `--primary` | `--primary-foreground` | `--primary` / 0.92 | 内高光 + 暗描边 |
| `destructive` | `--destructive` | `--destructive-foreground` | `--destructive` / 0.92 | 内高光 |
| `outline` | `--control-surface` / 0.6 | `--foreground` | `--control-hover` / 0.7 + `--accent-foreground` | `--surface-border` / 0.6 → `--surface-border-strong` |
| `secondary` | `--control-surface` | `--secondary-foreground` | `--control-hover` | 阴影 |
| `ghost` | 透明 | 继承 | `--accent` / 0.7 + `--accent-foreground` | 无 |
| `link` | 透明 | `--primary` | 下划线 | 无 |

补充一个构建层事实：`default` / `destructive` 的 hover 写的是 `bg-primary/92`、`bg-destructive/92`，但 `92` 不是 Tailwind 默认透明度刻度，当前构建产物里没有生成这两条规则；所以这两个变体的 hover 实际只改阴影。不要向用户承诺「hover 会变亮 8%」；需要明确变亮时，在皮肤里写 `hover` 规则或改用 `/90`。

### 5.2 会话 / 工作区 / Tab 选中态没有颜色

两个独立原因，经常同时出现：

1. **`--item-selected-bg` 缺失或格式错** → `!important` 直连规则把背景置为透明（见 §2）。必须是完整颜色。
2. **选中文字色把状态色一起吞了**：`skin-base.css` 有

   ```css
   html[class*="skin-"] .session-item-selected * { color: inherit !important; }
   ```

   选中行里的 `text-info`（运行中）、`text-warning`（等待确认）、`text-success`（已完成）都会被强制成 `--item-selected-fg`。如果 `--item-selected-fg` 是低饱和灰，状态图标就「没颜色」了。

   要保留状态色，用更高特异性 + `!important` 单独放行：

   ```css
   html[class*="skin-"] .session-item-selected .text-info { color: hsl(var(--info)) !important; }
   html[class*="skin-"] .session-item-selected .text-warning { color: hsl(var(--warning)) !important; }
   html[class*="skin-"] .session-item-selected .text-success { color: hsl(var(--success)) !important; }
   ```

推荐值（完整颜色，不是三元组）：

```css
--item-selected-bg: hsl(212 38% 24%);
--item-selected-fg: hsl(210 30% 96%);
```

选中底色与侧栏底色至少要有可辨差异；3px 状态条、状态点属于非文本指示器，对比度目标 ≥ 3:1。

### 5.3 状态点 / 状态图标颜色不对或不一致

- 左侧栏、TabSwitcher、委托图标已经 token 化：`bg-info`、`bg-warning`、`bg-success`、`text-info` 等。
- **顶栏 Tab 的状态边框仍是硬编码**：`.topbar-tab-status-running` = `hsl(217 91% 60%)`、`blocked` = `hsl(25 95% 53%)`、`completed` = `hsl(142 71% 45%)`。换皮肤后左侧栏跟了，顶栏没跟，就会「同一状态两种颜色」。
- 需要一致时，皮肤里显式覆盖（注意深色 inactive 规则特异性是 (0,4,0)）：

  ```css
  html[class*="skin-"] .topbar-editorial .topbar-tab-status-running,
  html[class*="skin-"] .topbar-editorial .topbar-tab-inactive.topbar-tab-status-running {
    border-color: hsl(var(--info)) !important;
  }
  html[class*="skin-"] .topbar-editorial .topbar-tab-status-blocked,
  html[class*="skin-"] .topbar-editorial .topbar-tab-inactive.topbar-tab-status-blocked {
    border-color: hsl(var(--warning)) !important;
  }
  html[class*="skin-"] .topbar-editorial .topbar-tab-status-completed,
  html[class*="skin-"] .topbar-editorial .topbar-tab-inactive.topbar-tab-status-completed {
    border-color: hsl(var(--success)) !important;
  }
  ```

- 状态色不要和 `--sidebar-surface` 落在同一明度；暗色皮肤最常见的是「五个表面全在 7%–10% 亮度」，状态点自然看不见。

### 5.4 输入区不跟随 / 边框不跟随

- 现代界面：`.agent-input-surface` 被 `globals.css` 的 `background-color: hsl(var(--input-surface)) !important` 接管，皮肤改 `--input-surface` 就够。
- 经典界面：`.ui-classic .agent-input-surface` 用 `--background` / 0.7 覆盖，必须用同特异性规则压回：

  ```css
  html[class*="skin-"].ui-classic .agent-input-surface {
    background-color: hsl(var(--input-surface)) !important;
  }
  ```

- `border-input` 读的是 `--input-surface`，不是 `--input`；想让输入框边框跟皮肤走，改 `--input-surface` 或直接覆盖 `border-input`。

### 5.5 Dialog / 菜单 / 浮层还是默认色

- 设置弹窗：`bg-dialog` + `text-dialog-foreground`，必须单独设计 `--dialog` / `--dialog-foreground`；只改 `--background` 不会变。
- 菜单/下拉：`bg-popover`（30 处），需要 `--popover` / `--popover-foreground`。
- 遮罩：`bg-overlay`；如果 `--overlay` 写成不透明纯色，弹窗后面会是一块死黑。但它是 Tailwind 组，**alpha 不能写进 token**（会拼成 `hsl(... / 0.6 / 0.4)`）；浓度由类名固定（设置弹窗是 `bg-overlay/40`）。皮肤里改 `--overlay` 的色相/明度即可，不建议为了改浓度去覆盖那条组件类名——`bg-overlay/40` 没有稳定的语义钩子，只能靠 `.fixed.inset-0.z-\\[100\\]` 这类与实现耦合的选择器。
- 光晕：`--dialog-glow-shadow` 是完整 `box-shadow`；写成颜色或三元组都会让整条声明失效。
- Portal 不是问题：Radix 的 Dialog/Popover 挂在 `document.body` 下，仍然是 `html` 的后代，`:root` token 正常继承。

### 5.6 消息区不生效

- `--message-surface` / `--message-user-surface` **只提供颜色**，不会把消息变成卡片。
- 整条卡片化：自己写

  ```css
  .message-item.is-assistant { background: hsl(var(--message-surface)); }
  .message-item.is-user { background: hsl(var(--message-user-surface)); }
  ```

- 只改用户小气泡：`.message-item.is-user [class~="bg-primary/10"]`。
- 正文柔化：`.message-item .prose { --tw-prose-body: hsl(var(--my-skin-message-foreground)); }`；不要覆盖 `pre` / `code` 的颜色，保护 Shiki 高亮。

### 5.7 滚动条 / 选区 / 代码块标题消失

都属于 §1.2 的直连组：必须是完整值。滚动条三态还要带 alpha，否则会变成一条实心色块：

```css
--scroll-thumb-bg: hsl(145 25% 45% / 0.20);
--scroll-thumb-hover: hsl(145 25% 45% / 0.32);
--scroll-thumb-active: hsl(145 25% 45% / 0.42);
--selection-bg: hsl(var(--accent-foreground) / 0.75);
--selection-color: hsl(var(--background));
--code-block-header-bg: rgb(34 42 37);
```

### 5.8 图表 / iframe / 导出页不跟随

- 皮肤 CSS 的选择器**进不了** iframe 片段、图表渲染器、OFV 预览、导出静态页；这些面只认被显式搬运的 token。
- 图表色板是 `--chart-1..8`（Tailwind 组，三元组），由 `visualization-theme.ts` 搬运；没定义就回落 `DEFAULT_CHART_PALETTE`。
- 圆角同理：`--radius` 的字面值能搬，文档级 catch-all 搬不过去；iframe 里胶囊/圆形用 `--radius-pill`，不要指望 `[class*="rounded"]`。
- 如果问题只出现在可视化/浏览器预览里，先读 `workspace-files/.context/memory-archive/theme-token-plumbing.md`，不要在主文档里盲调。

### 5.9 圆角在经典界面不生效

`:root.ui-classic { --radius: 0.625rem }` 的特异性是 (0,2,0)，皮肤 `:root` 是 (0,1,0)。所以皮肤写 `--radius: 0` 在经典界面会被压回 10px。

修法（二选一）：

```css
html[class*="skin-"].ui-classic { --radius: 0px; }
```

或继续用文档级 catch-all（只对主文档有效）：

```css
[class*="rounded"] { border-radius: 0 !important; }
```

## 6. 透明底：先分清是哪一种

「透明底」在 Profer 里有三种完全不同的含义，能力边界也不同。

### 6.1 看到桌面（窗口穿透）

**不是皮肤 CSS 能保证的事。** 主窗口创建参数（`src/main/index.ts`）是：

- 没有 `transparent: true`；
- 显式 `backgroundColor: getWindowFrameColor()`（不透明）；
- macOS 额外有 `vibrancy: 'under-window'` + `visualEffectState: 'followWindow'`。

所以：

- Windows / Linux：主窗口没有透明通道，皮肤把 renderer 全变透明也只会露出 `backgroundColor`。
- macOS：有 vibrancy 合成，理论上可以让系统材质透出，但当前 `backgroundColor` 是不透明值，实际能否透出必须在真机验证，不能凭 CSS 推断。
- 真要做「桌面穿透」，属于主进程改动（`transparent: true` + `backgroundColor: '#00000000'`，并处理 Windows 无原生阴影、点击穿透、性能），**不是皮肤包的范围**。Quick Task 窗口和语音窗口是 `transparent: true`，但主窗口不是。

结论：用户说「透明底」时，先问清是「看到桌面」还是「层间半透明」；前者要明确说明需要源码改动，不要用皮肤 CSS 假装做到了。

### 6.2 层间半透明（露出壁纸/下层）

这是皮肤可以做的，但必须同时处理四层，缺一层就会「透不出来」：

1. **文档层**：`body` 默认 `@apply bg-background`，不透明。
2. **外壳层**：`.shell-bg` 同时有 `bg-surface-shell`（不透明）和 skin-base 的 `background: var(--shell-bg-gradient)`。
3. **面板层**：`bg-content-area`、`bg-sidebar`、`bg-card`、`bg-surface-raised`、`bg-dialog` 各自不透明。
4. **输入/浮层**：`.agent-input-surface`、`bg-popover` 等。

最小可行配方：

```css
html, body { background: transparent !important; }

/* 壁纸挂在外壳；background 简写会重置 bg-surface-shell 的颜色 */
.shell-bg {
  background-color: transparent !important;
  background-image:
    linear-gradient(hsl(222 30% 9% / 0.35), hsl(222 30% 9% / 0.35)),
    url("assets/background.webp");
  background-size: cover;
  background-position: center;
}

/* 面板半透明：token 三元组本身不能带 alpha（会被 hsl(... / a / 1) 拼坏），
   所以 alpha 必须落在具体承载类上 */
[class~="bg-content-area"] { background-color: hsl(var(--content-area) / 0.78) !important; }
[class~="bg-sidebar"] { background-color: hsl(var(--sidebar-surface) / 0.82) !important; }
[class~="bg-surface-raised"] { background-color: hsl(var(--raised-surface) / 0.86) !important; }
[class~="bg-card"] { background-color: hsl(var(--card) / 0.86) !important; }
[class~="bg-dialog"] { background-color: hsl(var(--dialog) / 0.92) !important; }
[class~="bg-popover"] { background-color: hsl(var(--popover) / 0.94) !important; }
```

注意：

- **不能**把 alpha 塞进 Tailwind 组 token：`--content-area: 222 30% 9% / 0.78` 会生成 `hsl(222 30% 9% / 0.78 / 1)`，整条声明失效，反而变透明。
- `.shell-bg` 用 `background` 简写会重置 `background-color`；要保留 `bg-surface-shell` 的底色就写 `background-image`，要透明就显式 `background-color: transparent`。
- `--shell-bg-gradient` 不定义时，skin-base 的 `background: var(--shell-bg-gradient)` 会让外壳变透明（§2）；所以透明皮肤反而必须定义它，或在皮肤里覆盖 `.shell-bg`。
- 半透明面板叠阴影/模糊容易发灰；`backdrop-filter` 还会引入合成层问题（§3.2），优先用带 alpha 的纯色。
- 快速任务窗口也是同一套 renderer；`body` 透明会影响它。若该窗口需要实体卡片，给它的容器单独补不透明底色。

### 6.3 无背板（局部透明）

只想让某个区域「没有底色」，例如输入框、卡片、侧栏：优先改该表面的 token，让它与父层同色；不要用 `opacity`（会连文字一起淡）或 `visibility`。需要真正的 alpha 时，按 6.2 的「具体承载类」写法处理。

## 7. 交付前自检清单

1. Tailwind 组全是 `H S% L%`，没有 `/ alpha`、`#hex`、`rgb()`、`hsl()`；透明度只出现在类名修饰符上（例外只有 §1.2.1 的 `--diff-*` / `--tiptap-pre-bg`）。
2. 直连组全是完整值；`--item-selected-bg`、`--mode-slider-bg`、`--scroll-thumb-*`、`--selection-bg` 没有写成裸三元组。
3. `--shell-bg-gradient` 已定义；否则外壳会透明。
4. A/B/C 三组都有值（分组见 `css-recipes.md` §2）；D/E/F 按需要补；`--chart-1..8` 有值。
5. 选中态：`.session-item-selected` 有可见底色；状态图标在选中行里仍有状态色（或明确接受被统一）。
6. 按钮：default / outline / secondary / ghost 至少各看一个；文字与背景对比度 ≥ 4.5:1。
7. 输入区：现代 + 经典两种界面都看；经典界面需要 `.ui-classic` 同特异性覆盖。
8. Dialog / Popover / Tooltip / 遮罩：四个浮层表面都不是默认灰。
9. 透明底：明确是「桌面穿透」还是「层间半透明」；前者不要声称已实现。
10. 圆角：经典界面下 `--radius` 是否被 `:root.ui-classic` 压回；iframe 里是否仍然有圆角。
11. 没有在 `html` / `body` / `#root` / `.shell-bg` 上加 `transform` / `filter` / `backdrop-filter`。
12. 临时探针、调试面板、`!important` 试验规则都已删除。
