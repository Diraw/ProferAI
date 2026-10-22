---
name: profer-theme-authoring
description: The meta-prompt for Profer skins (皮肤 / skin packages): identifies the task type, routes to the single token contract, enforces the v2 surface hierarchy, and keeps acceptance honest. Use when users ask to create, modify, reproduce or optimize a Profer skin, a special style, dark or light palettes, skin previews, skin tokens or title-bar colors, or report that a skin is not taking effect, still looks like the default colors, is not followed by the settings page or input field, loads more slowly after switching, or is not synchronized across windows.
compatibility: Modifying built-in skin source requires read/edit/bash access to the Profer source repository (apps/electron); user skins only require create_skin or read/write access to the user skin directory.
version: "1.1.1"
---

# Profer Skin Meta-Prompt

Your job is to turn a skin request into an **installable, verifiable** skin package, and to report honestly how far verification actually went. This file defines decisions, routing and hard constraints; mechanism, CSS recipes and acceptance details live in `references/` and are read on demand.

## 1. Identify the task type first

| Type | Approach | Risk |
|---|---|---|
| New skin | Design tokens → implement → acceptance | Medium |
| Adjust an existing user skin | Edit only inside the user skin directory; verify window and surfaces | Low |
| Change native light / dark mode | Do not override `:root` / `.dark` with skin tokens by default; explain impact and get explicit confirmation | High |
| Change only the preview image | Verify card asset and framing; do not claim visual verification | Low |

If the user supplies a palette or screenshot, treat it as the visual baseline; do not replace it with a supposedly "better" scheme.

## 2. Read the single source of truth; do not work from memory

All repo paths below are relative to the Profer repository root (the directory containing `apps/electron`). Resolve it first; do not assume the session cwd is the repo root.

- **Token contract (authoritative)**: `apps/electron/resources/skin-template/skin.css` and `manifest.json`. The Settings "authoring guide" imports these exact files and the component comment calls them the only source of truth. Read them before writing any token.
- **Consumers of the contract**: `renderer/styles/skin-base.css` (public rules that consume optional tokens), `tailwind.config.js` (token → utility mapping), and the `:root` / `.dark` defaults in `renderer/styles/globals.css`.
- **Validation**: `main/lib/skin-service.ts` `auditSkinCss` (what CSS is rejected) and `main/lib/skin-manager-service.ts` (package limits, manifest fields).
- **Built-in skins are examples, not the contract.** Read at most one light and one dark (`forest-light` / `forest-dark`) to compare real layer separation. All built-in skins map v2 tokens onto their v1 palette (`--shell-surface: var(--background)`); that is a compatibility shape, not the canonical contract. Only `skin-template/skin.css` assigns v2 surfaces directly — use it for token syntax.
- Mechanism, title bar, caching and install locations: `references/mechanism.md`.
- Selectors, token groups and special-case rules: `references/css-recipes.md`.
- Acceptance and delivery wording: `references/verification.md`.
- When the issue is "colors do not follow the skin" inside rendering code (visualization, browser preview), also read `workspace-files/.context/memory-archive/theme-token-plumbing.md`.
- **Scan boundaries**: `ls` / `rg` inside these fixed roots is fine and expected: `apps/electron/resources/skins/`, `apps/electron/resources/skin-template/`, `apps/electron/src/renderer/styles/`, and the user skin directory (`~/.profer/skins/`, dev builds `~/.profer-dev/skins/`). Only full-disk recursive scans (`find /`, `ls -R ~`, `Get-ChildItem -Recurse` from home) are forbidden — they cross protected directories such as `~/Music` and trigger macOS privacy prompts. The `installedPath` returned by `create_skin` is the definitive install location; do not search for it afterwards.

## 3. Implementation approach

- **Use `create_skin` by default**: pass `id`, `name`, `tone` (`light`|`dark`), `skinCss`; pass `wallpaperPath` when an authorized wallpaper exists, `previewPath` when a thumbnail is needed, `previewScale` / `previewPosition` for framing, `titlebarColor` / `titlebarSymbolColor` for the title bar. It copies wallpapers into `assets/`, audits the CSS, installs atomically and refreshes the library. It writes `contractVersion: 2` for you.
- `apply` defaults to `true`; pass `apply: false` only when the user explicitly wants it installed but not activated.
- **Adjust a user skin**: edit files under `~/.profer/skins/{id}/` directly, then refresh in Settings.
- **Change a built-in skin**: edit `apps/electron/resources/skins/{id}/`, then `bun run build:resources` and rebuild. High-cost path; prefer a user skin unless explicitly requested.
- A user skin with the same id as a built-in skin is skipped in favor of the built-in one. Use a different id, or confirm the conflict before installing.
- One asset image ≤ 4 MB, whole package ≤ 5 MB, `skin.css` ≤ 512 KB, preview ≤ 2 MB.
- Pass `replace: true` only with explicit overwrite authorization.

## 4. Hard design constraints

- **Design by layer, using the v2 surface contract.** The layers and their real carriers are listed in `references/css-recipes.md` §3. Minimum distinct set for a dark skin: shell (`--shell-surface`), main canvas (`--content-area`), raised/card (`--raised-surface` / `--card`), input (`--input-surface`), overlay (`--dialog` / `--popover`). "Everything gray at 7%–10% lightness" is not a hierarchy.
- **Declaring v2 is not the same as implementing v2.** `create_skin` always writes `contractVersion: 2`. If the CSS only fills the old ~20 shadcn tokens, the remaining v2 surfaces inherit `.dark` defaults and the skin will look half-applied. Fill groups A/B/C at minimum; D/E/F when overlays, messages, status or charts matter.
- **Optional contract tokens are opt-in.** `skin-base.css` consumes `--item-selected-bg`, `--scroll-thumb-*`, `--selection-bg`, `--dialog-glow-shadow` and friends with no fallback and no globals default. If the skin does not define them, those public rules are simply inert. Define them when the user cares about selection states, scrollbars or code blocks.
- **Text contrast**: body text ≥ 4.5:1 against its background; explain the tradeoff for intentionally low-contrast art styles.
- **Do not override native styles**: do not change global tokens for native light / dark mode unless the high-risk task in §1 is confirmed.
- **Resource safety**: `url()` and `src()` may only reference lowercase `assets/…png|webp|svg|jpg|jpeg`. `data:`, `file:`, external links, absolute paths, `../`, `@import`, `@font-face` and CSS escapes inside `url()` are rejected by `auditSkinCss`. Wallpaper rules belong on `.shell-bg`.
- **Verify the pipeline before tuning colors**: if a skin looks like default dark mode, first use a high-contrast probe to confirm the renderer received the skin tokens, then remove the probe immediately.
- **Platform differences are real**: `manifest.titlebar` is applied live via `setTitleBarOverlay` only on Windows; on macOS the color is read when the window is created, so a skin switch may require a restart to show the new frame color. Never report a macOS title-bar check as if it were a Windows overlay check.

## 5. Acceptance and delivery

- Follow `references/verification.md`. Static checks, a successful build or a successful install are **not** "the skin is implemented".
- Only claim runtime verification when you actually have computed-style or visual evidence. If the session has no DevTools/CDP access, say so and list it as unverified instead of inventing a result.
- The final response must list: skin name and id; files involved (package directory and any source changes); the key palette/tokens by layer; whether a probe or debug panel was removed; which static and runtime checks were actually performed; and what remains unverified (for example main-process restart, title bar, multi-window sync).
