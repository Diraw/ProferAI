# skin.css 写法与配方

## 1. token 表

至少定义以下 token；未定义会继承 globals.css 默认值：

```css
:root {
  --background: ...; --foreground: ...; --muted: ...; --muted-foreground: ...;
  --border: ...; --input: ...; --ring: ...; --primary: ...; --primary-foreground: ...;
  --secondary: ...; --secondary-foreground: ...; --accent: ...; --accent-foreground: ...;
  --card: ...; --card-foreground: ...; --popover: ...; --popover-foreground: ...;
  --dialog: ...; --dialog-foreground: ...; --content-area: ...; --sidebar-surface: ...;
  --tabbar-surface: ...; --input-surface: ...; --tab-surface: ...; --tooltip: ...;
  --tooltip-foreground: ...; --tooltip-muted: ...; --code-bg: ...;
}
```

## 2. 层级约定

| 层级 | 主要 token / 载体 | 说明 |
|---|---|---|
| 主画布 | `--content-area` | 对话与主工作区背景 |
| 应用框架 | `--background`、`--sidebar-surface`、`--tabbar-surface` | 侧栏、Tabbar、外框 |
| 交互表面 | `--card`、`--tab-surface`、`--input-surface` | 卡片、标签、输入区 |
| 浮层 | `--popover`、`--dialog`、`--tooltip` | 菜单、设置、弹窗 |
| 文字 | `--foreground`、`--muted-foreground` 及必要的皮肤专用正文 token | 必须检查消息 Markdown 的实际呈现 |
| 品牌与状态 | `--primary`、`--ring`、`--destructive` | 焦点、按钮、危险动作 |

暗色皮肤应让主画布、框架、卡片、输入区和弹窗可辨。低饱和灰可用少量色相或饱和度表达冷暖，避免无意的棕黑。

## 3. 皮肤专用 token

按需追加，例如正文柔和化用 `--<皮肤id>-message-foreground`，再用**皮肤文件内的特例规则**（不需要 `skin-` 前缀）作用于 `.message-item .prose`。不要在通用组件上无差别覆盖全局 `--foreground`。

## 4. 资源引用

写 `url("assets/background.webp")`，由 `getSkinCss` 自动转为 `profer-skin://` 协议。禁止 `data:`、`https:`、`file:`、绝对路径、`../`，安装校验会直接拒绝。

## 5. 特例规则（无需 skin- 前缀）

皮肤文件注入后全局生效。`html[class*="skin-"]` 前缀只属于 skin-base.css 的公共规则。

- **背景图**：不要挂在 `body`。AppShell 的 `.shell-bg` 是应用外壳，背景图写在 `.shell-bg` 上。skin-base.css 的默认 shell 规则已降为低特异性，裸 `.shell-bg { background-image: ... }` 与带 `html[class*="skin-"]` 前缀的写法都可生效。
- **输入框**：`ui-classic .agent-input-surface` 可能以 `!important` 覆盖 `--input-surface`。若该规则存在，皮肤需要更具体的限定选择器，例如 `.ui-classic .agent-input-surface { ... !important }`。
- **设置页**：设置窗口使用 `bg-dialog`，因此 `--dialog` 与 `--dialog-foreground` 必须单独设计。
- **聊天正文**：实际 Markdown 位于 `.message-item .prose`。要让正文更柔和，用 `--tw-prose-*` 与文字选择器，限定在皮肤范围内；不要覆盖 `pre` / `code`，以保护 Shiki 高亮。
- **动画与毛玻璃**：用 `@keyframes` + transform/opacity（走合成层）。大范围 backdrop-filter 注意性能。加 `prefers-reduced-motion` 降级。

## 6. 圆角与几何

皮肤若用文档级规则表达“直角”（如 `[class*="rounded"]{border-radius:0!important}`），这类规则进不了 iframe 片段和图表渲染器，只搬 `--radius` 字面值会失效。正确做法是读取 app 文档中真实元素的计算圆角再下发，见 theme-token-plumbing.md 的 `applyEffectiveRadii`。

## 7. 调色探针

若新皮肤看起来像默认深色，先不要连续调 token。先用一个临时高对比探针（白色或艳色）确认 renderer 确实接受皮肤 token，确认后立即换回目标设计，探针不能留在正式皮肤中。

临时调试器要求：
- 仅 `import.meta.env.DEV` 显示，且仅目标皮肤选中时显示；
- 不写 settings；
- 滑条分别控制真实表面：主画布、框架/侧栏、卡片、输入区、设置 Dialog、聊天正文、灰阶冷暖、焦点色；
- 聊天正文只能皮肤限定；
- 提供复制 token、重置、关闭；
- 用户确认色板后，立即回填 CSS 并删除调试器；
- 不能进入 production build。

## 8. 色彩检查

- 让用户看真实窗口，再决定更浅、更灰、更暖或更冷；不仅凭 HSL 直觉断言视觉正确。
- 对主要文字/背景、次级文字/背景、按钮文字/primary 计算 WCAG 对比度。正文和小字目标至少 4.5:1；低对比艺术风格需说明取舍。
- 层级优先于“整体变灰”：框架、主画布、卡片、输入、Dialog 应有合理可辨差异。
