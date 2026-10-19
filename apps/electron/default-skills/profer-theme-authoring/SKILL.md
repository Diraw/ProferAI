---
name: profer-theme-authoring
description: The meta-prompt for Profer skins (skin packages): responsible for identifying skin task types, selecting implementation approaches, and enforcing design and acceptance constraints, while routing to mechanism, CSS recipes, and verification checklists as needed. Use this skill when users request creating, modifying, reproducing, or optimizing a Profer skin, a special style, dark or light color schemes, skin previews, skin tokens, or title-bar colors, or report that a skin is not taking effect, still looks like the default colors, is not followed by the settings page or input field, loads more slowly after switching, or is not synchronized across multiple windows.
compatibility: Modifying built-in skin source requires read/edit/bash access to the Profer source repository (apps/electron); user skins only require create_skin or read/write access to the user skin directory.
version: "1.0.1"
---

# Profer Skin Meta-Prompt

Your responsibility is to turn the user's skin requirements into a **installable, verifiable** skin package and report honestly how far verification has progressed. This file defines only decisions, routing, and hard constraints; mechanism details, CSS recipes, and the acceptance checklist are in `references/` and should be read as needed.

## 1. Identify the task type first

| Type | Approach | Risk |
|---|---|---|
| New skin | Design tokens → implement → complete acceptance | Medium |
| Adjust an existing user skin | Modify files only within the user skin directory; verify the window and title bar | Low |
| Change native light / dark mode | By default, do not override `:root` or `.dark` with skin tokens; explain the impact first and obtain explicit confirmation | High |
| Change only the preview image | Verify card assets and layout; do not claim visual verification | Low |

If the user provides a color palette or screenshot, use it as the visual baseline and do not replace it with a supposedly "better-looking" scheme.

## 2. Gather evidence as needed; do not rely on memory

- For mechanisms, limitations, installation locations, the title bar, and caching: read `references/mechanism.md`. When the issue involves colors not following a skin or reading tokens from rendering code, also read the workspace memory `workspace-files/.context/memory-archive/theme-token-plumbing.md`.
- For writing `skin.css`, selectors, and special-case rules: read `references/css-recipes.md`.
- For acceptance, runtime assertions, and delivery wording: read `references/verification.md`.
- For reference token syntax, read only `apps/electron/resources/skins/mist-paper-dark/` (the built-in repository reference) or the user skin directory `~/.profer/skins/` (development builds use `~/.profer-dev/skins/`), these two fixed locations.
- **Do not** use `find`, `ls -R`, `Get-ChildItem -Recurse`, `dir /s`, or other recursive or full-disk scans to locate skin directories; this traverses protected directories such as `~/Music` and can trigger macOS privacy prompts. The `installedPath` returned by `create_skin` is the definitive location.

## 3. Implementation approach

- **Use `create_skin` by default**: pass `id`, `name`, `tone` (light|dark), and `skinCss`; when an authorized wallpaper is available, pass `wallpaperPath`; when a thumbnail is needed, pass `previewPath`; use `previewScale` / `previewPosition` for framing and `titlebarColor` / `titlebarSymbolColor` for the title bar. It copies wallpapers into `assets/`, validates them, installs atomically, and refreshes the skin library.
- **Adjust only a user skin**: edit files directly under `~/.profer/skins/{id}/`; refresh in Settings.
- **Change a built-in skin**: modify `apps/electron/resources/skins/{id}/`, then rerun `bun run build:resources` and rebuild. This is the high-cost path; unless the user explicitly requests it, prefer a user skin.
- A same-named user skin is skipped in favor of the built-in skin; use a different id or confirm the built-in conflict before installing.
- A single asset image must not exceed 4 MB, and the entire package must not exceed 5 MB; when a generated image is too large, compress or convert it first with an existing system image tool, then install it.
- Pass `replace: true` only when the user explicitly requests overwriting an existing skin.

## 4. Hard design constraints

- **Design by hierarchy**: the main canvas, application frame, cards, input area, overlays, text, and brand states each have a role. Do not replace hierarchy with "making everything gray"; a dark skin must at least distinguish the main canvas, frame, cards, input area, and dialogs.
- **Text contrast**: body text must reach at least 4.5:1 against its background; explain the readability tradeoff for low-contrast artistic styles.
- **Do not override native styles**: do not change the global tokens of native light / dark mode in a skin unless the high-risk task in Section 1 has been confirmed.
- **Resource safety**: `url()` may use only relative paths under `assets/`, with lowercase filenames; `data:`, `file:`, external links, absolute paths, `../`, and references to session output directories are prohibited. Wallpaper rules may be placed on `.shell-bg`.
- **Verify the pipeline before tuning colors**: if a skin looks like the default dark mode, first use a high-contrast probe to confirm that the renderer is actually receiving the skin tokens; remove the probe immediately after confirmation and do not leave it in the production skin.
- Do not consider "changing only the grayscale" complete; let the user see the real window before deciding whether it should be lighter, warmer, or cooler.

## 5. Acceptance and delivery

- Follow `references/verification.md` for acceptance. When only static checks or a build have passed, call it only "verified at the static / artifact level".
- Do not describe "source changed", "build succeeded", or "installation succeeded" as "the skin has been implemented".
- The final response must list: the skin name and id; the files involved (skin package directory and source changes); the key palette or tokens; whether the probe was removed; the builds and runtime verification performed; and unverified items (for example, whether restarting the main process is required or whether the title bar has been inspected).
