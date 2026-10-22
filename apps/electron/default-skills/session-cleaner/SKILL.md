---
name: session-cleaner
description: Clean Profer session JSONL into readable Markdown conversations and support progressive reading of oversized sessions (overview / outline / search / export by turn range), avoiding context exhaustion from loading everything at once. Use this skill when the user mentions "clean a session", "parse a session file", "extract session context", "filter streaming noise", "export a session to Markdown", "convert a session into a conversation", "organize agent-sessions", or "see what a session was about".
version: 2.0.2
license: AGPL-3.0-only
---

# Session Cleaner

Clean sessions in `~/.profer/agent-sessions/<id>.jsonl` that have been polluted by streaming snapshots into clean Markdown conversations.

This skill is a **thin wrapper** around the `profer` CLI: all parsing, snapshot deduplication, and rendering logic lives in `@profer/session-core` (the repository's single source of truth) and is exposed by the `profer session` command. The skill itself does not parse JSONL; it only teaches you to invoke the CLI in the correct order.

> History: v1 included a Python parser (an independently duplicated copy of the session format that drifted as the internal format changed). Starting with v2, it calls the `profer` CLI in the repository so format knowledge is stored in one place.

## Why reading progressively matters

Session JSONL may be very large (a single raw session file has been observed at 50MB). Cleaning the entire file and loading it into context at once can exhaust the token budget immediately. The correct approach is to **inspect the structure first, locate the relevant area next, and take only the required fragment last**:

1. `profer session info <id>` — inspect size: turn count, estimated tokens, and byte count. Decide first whether the whole session can be read.
2. `profer session outline <id>` — inspect the map: one line per turn (role + preview + tool summary + tokens). Locate the turn indexes of interest.
3. `profer session search <keyword> <id>` — find content: returns matching turn indexes + snippets.
4. `profer session export <id> --turns A-B` — export only the required turn range into context.

**Only when `info` shows a small size (for example, estimated tokens < a few thousand) should you directly run `export <id>` to read the entire session.** The CLI has a built-in guard: when no turn range is specified and output exceeds 50KB, it refuses to print directly, writes the result to disk, and prompts you to use `--turns`.

## Command quick reference

```bash
# List sessions (descending by update time)
profer session list [--limit N] [--workspace W]

# Size/structure overview — run this before deciding how to read
profer session info <id|path>

# Turn-level map: one line per turn
profer session outline <id|path> [--offset K] [--limit N]

# Search a keyword within a session; returns matching turn indexes + snippets
profer session search <keyword> <id|path> [--context N] [--limit N] [--case-sensitive]

# Export clean Markdown (windowed)
profer session export <id|path> --turns 5-12       # Export only turns 5-12
profer session export <id|path> --head 4           # First 4 turns
profer session export <id|path> --tail 4           # Last 4 turns
profer session export <id|path> --out cleaned/x.md # Save an archive (not subject to the guard)
profer session export <id|path> --stdout           # Force full output (use with caution; bypasses the guard)

# All commands support --json for machine-readable results
profer session info <id> --json
```

## Typical workflow

**Scenario: the user asks "What did we discuss about X in the previous session?"**

```bash
# 1. Find the session
profer session list --limit 5
# 2. Inspect size (assume it is large)
profer session info <id>
# 3. Search for the keyword
profer session search "X" <id>
#    → matches #7 #12
# 4. Export the neighborhood around matches only
profer session export <id> --turns 6-13
```

**Scenario: the user wants to archive a small session as a complete Markdown file**

```bash
profer session info <id>          # Confirm it is small
profer session export <id> --out cleaned/<id>.clean.md
```

## Output shape

Cleaned Markdown is divided into sections by role (`## User` / `## Assistant`). Tool calls are compressed into single lines such as `> [Tool: name args]` (consecutive identical calls are folded as `×N`), while thinking and raw tool results are discarded:

```markdown
## User

Help me configure a robot icon...

## Assistant

I will explore the codebase first.

> [Tool: Read file_path=/a/b.ts]
> [Tool: Bash command=ls assets ×3]
```

## CLI location

- **Packaged build (production)**: the `profer` binary is distributed with the desktop App and should be on PATH or injected by the runtime (see PR4). Prefer calling `profer session ...` directly.
- **Development/source environment**: if `profer` is not on PATH, run the source directly with `bun <repo>/apps/cli/src/index.ts session ...`.
- **Configuration directory**: the CLI reads `~/.profer` by default; development-mode data is in `~/.profer-dev`, so add `--dev` or set `PROFER_DEV=1`.

## Implementation notes (for maintainers)

- Parsing, snapshot deduplication, and rendering all live in `@profer/session-core`; the CLI only routes commands. Fix bugs or change formats in core, not by adding parsing logic to this skill.
- Format details (streaming snapshot fragmentation, `message.id` merging, and normalization of legacy flat formats) are documented in `references/cli-usage.md` and the core package source.
