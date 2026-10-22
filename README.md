<div align="center">

<img src="./docs/assets/profer-banner.svg" alt="Profer" width="100%" />

# Profer

**Your AI workforce in a desktop app**

Built for people who need AI to *do* things, not just chat. Profer runs autonomous agents locally—planning multi-step tasks, coordinating parallel sub-agents, scheduling recurring work—while keeping your data and workflows under your control.

[![Release](https://img.shields.io/github/v/release/Yuan-lai-ru-ci/ProferAI?style=flat-square)](https://github.com/Yuan-lai-ru-ci/ProferAI/releases)
[![License](https://img.shields.io/github/license/Yuan-lai-ru-ci/ProferAI?style=flat-square)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Yuan-lai-ru-ci/ProferAI?style=flat-square)](https://github.com/Yuan-lai-ru-ci/ProferAI)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](https://github.com/Yuan-lai-ru-ci/ProferAI/pulls)

[下载 macOS / Windows 版本](https://github.com/Yuan-lai-ru-ci/ProferAI/releases) · [文档](./docs) · [加入社区](#community)

English | [简体中文](./README.zh-CN.md)

</div>

---

## Why Profer?

Most AI tools give you a chatbot. Profer gives you an agent that **executes**, **coordinates**, and **automates**.

- **Chat is for questions.** Agent is for tasks that take hours or require multiple steps.
- **One-shot prompts are brittle.** Profer breaks complex work into dependency graphs and executes them reliably.
- **You shouldn't babysit AI.** Profer runs unattended jobs—daily reports, repo health checks, research pipelines—and reports back when done.

Built on dual runtimes ([Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) + [Pi Agent SDK](https://www.npmjs.com/package/@earendil-works/pi-agent-core)), Profer balances autonomy with control: agents work independently, but you see their plan before they commit changes, and you own all the data locally.

---

<img src="./docs/assets/features-showcase.svg" alt="Profer core capabilities" width="100%" />

---

## What makes Profer different

### 🎯 Agent-first, not chat-first

Profer distinguishes simple queries from actual work:

- **Chat mode** for quick questions, brainstorming, document drafts  
- **Agent mode** for multi-step execution: coding, file operations, research synthesis, data pipelines  

Agents break tasks into subtasks with explicit dependencies, execute them in parallel when possible, and surface checkpoints when you need review.

### 🤝 Collaborative sub-agents

Spawn multiple agent sessions for parallel workstreams. Each sub-agent gets its own workspace, full context, and autonomy—you orchestrate at a high level and collect results when they're ready.

**Example:** Analyzing a codebase? Spawn three agents:  
→ Agent A: scan for security issues  
→ Agent B: profile performance bottlenecks  
→ Agent C: extract architecture diagram  

All run concurrently; you review consolidated findings.

### ⏰ Scheduled automation

Set recurring tasks with cron-like schedules (daily / weekly / monthly / interval). Profer executes them unattended and logs:

- Success / failure history  
- Output artifacts (reports, updated files, notifications)  
- Retry logic for transient errors  

**Use cases:**  
→ Generate weekly team status from Git + Jira  
→ Monitor competitor landing pages for changes  
→ Sync research papers to a knowledge base nightly  

### 📱 Mobile companion

Use your phone to trigger desktop agents or review their work. The mobile client (Capacitor-based, separate repo: [Profer-pocket](https://github.com/Yuan-lai-ru-ci/Profer-pocket)) connects over local network or VPN—no cloud relay required.

### 🔒 Local-first by default

Workspaces, sessions, skills and files stay on your machine—no account required.

> **2026-10-11 变更**：桌面端内置的团队工作区运行时已移除（产品入口、IPC 与同步链路一并下线），本仓库不再分发团队功能。

---

## Demo

<img src="./docs/assets/screenshots/profer-main-demo.png" alt="Profer agent executing a multi-step task with dependency graph" width="100%" />

*Agent breaking down a task into subtasks, executing file operations, running tests, and awaiting review before final commit.*

---

## Quick start

### 1. Install

Download from [Releases](https://github.com/Yuan-lai-ru-ci/ProferAI/releases):  
- **macOS**: Apple Silicon or Intel DMG  
- **Windows**: 64-bit installer  

Profer checks dependencies on first launch (Git, Node.js or Bun, working shell).

### 2. Connect a model

**Settings → Model Configuration**  

Add one or more providers. Profer supports:

| Provider | Chat | Agent (Pi runtime) | Agent (Claude runtime) | Notes |
|----------|------|-------------------|------------------------|-------|
| Anthropic | ✅ | ✅ | ✅ | Native Claude Messages API |
| DeepSeek | ✅ | ✅ | ✅ | Anthropic-compatible |
| Kimi (Moonshot) | ✅ | ✅ | ✅ | Anthropic-compatible |
| OpenAI | ✅ | ✅ | ❌ | Pi runtime supports OpenAI protocol |
| Google Gemini | ✅ | ✅ | ❌ | Pi runtime only |
| 智谱 AI | ✅ | ✅ | ✅ | Anthropic-compatible |
| MiniMax | ✅ | ✅ | ✅ | Anthropic-compatible |
| 豆包 (Doubao) | ✅ | ✅ | ❌ | Pi runtime only |
| 通义千问 (Qwen) | ✅ | ✅ | ❌ | Pi runtime only |
| xAI / Grok | ✅ | ✅ | ❌ | Pi runtime, experimental flag required |
| Ollama | ✅ | ✅ | ✅ | Local models, OpenAI-compatible |
| Custom endpoint | ✅ | ✅ | ❌ | OpenAI-compatible API |

### 3. Start working

- **Chat**: Quick conversations, brainstorming, document editing  
- **Agent**: Complex tasks—coding, file batch operations, research synthesis  

Agents show you their execution plan before making irreversible changes.

---

## Use cases

### For developers

- **Codebase refactoring**: "Extract all API calls into a service layer, update tests"  
- **Dependency audits**: "List all outdated packages, check for security advisories, propose upgrade plan"  
- **Documentation generation**: "Scan `/src`, extract public APIs, write OpenAPI spec + usage examples"  

### For researchers

- **Literature review**: "Find papers on X published after 2023, extract methodology and datasets, summarize in a table"  
- **Data pipeline**: "Download dataset from Y, clean missing values, run correlation analysis, generate report with plots"  

### For teams

- **Recurring reports**: Schedule weekly summary of merged PRs, open issues, and release notes  
- **Monitoring**: Daily check of competitor pricing pages; alert on changes  
- **Knowledge sync**: Nightly sync of new Slack threads, Notion pages, or Confluence docs into a unified knowledge base  

---

## Architecture

Profer is a **local-first Electron app**: workspaces, sessions and files stay on your machine.

<img src="./docs/assets/architecture-diagram.svg" alt="Profer architecture diagram" width="100%" />

### Tech stack

- **Runtime**: Bun  
- **Desktop**: Electron 43  
- **Frontend**: React 18 + TypeScript + Jotai state  
- **UI**: Tailwind CSS + Radix primitives  
- **Rich content**: TipTap editor, Beautiful Mermaid, KaTeX math, Shiki syntax highlighting  
- **Agent SDKs**:  
  - [`@anthropic-ai/claude-agent-sdk@0.3.201`](https://github.com/anthropics/claude-agent-sdk)  
  - [`@earendil-works/pi-agent@0.86.1`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)  
- **Mobile**: Capacitor (Android client in [Profer-pocket repo](https://github.com/Yuan-lai-ru-ci/Profer-pocket))  

---

## Development

Profer is a Bun workspace monorepo:

```text
profer/
├── packages/
│   ├── shared/                # Shared types, IPC contracts, config, utils
│   ├── core/                  # Provider adapters, SSE, syntax highlighting
│   ├── ui/                    # Shared React component library
│   ├── session-core/          # Headless session read / group / search / render
│   ├── session-store/         # Node-only session persistence: index, messages, events, workspace blobs
│   ├── project-core/          # Headless project orchestration: graph build, state replay, query
│   ├── agent-runtime/         # Host-independent agent execution contracts and runtime lifecycle
│   ├── agent-provider-claude/ # Claude Agent SDK provider: query stream, permissions, background tasks
│   ├── agent-provider-pi/     # Pi Agent SDK provider: adapter, message conversion, Pi tools
│   ├── agent-fabric/          # Agent Node / Task Graph / Capability / Policy contracts
│   ├── edition-contract/      # Edition capability contract: account session, managed credentials, edition id
│   ├── office-engine/         # DOCX / PPTX / XLSX dual-plane layout parsing engine
│   └── plugin-api/            # Public contracts for third-party plugins
└── apps/
    ├── electron/              # Electron desktop app
    └── cli/                   # CLI: progressive session reading (list / info / outline / search / export)
```

### Setup

```bash
bun install        # Install dependencies
bun run dev        # Development mode (Vite + Electron hot reload)
bun run typecheck  # Type check all packages
bun test           # Run tests
```

### Build for production

```bash
cd apps/electron
bun run dist:mac       # macOS binary（当前架构）
bun run dist:win       # Windows installer（需在 Windows 主机执行，见 verify:packaging-host:win）
```

Artifacts appear in `apps/electron/out`.

### Contributing

<img src="./docs/assets/contributing-guide.svg" alt="Contributing to Profer" width="100%" />

We welcome PRs! Before submitting:

- Use **Bun** (no npm/pnpm lockfiles)  
- State management via **Jotai**  
- No `any` in TypeScript; prefer `interface` over `type` for object shapes  
- New IPC: update types in `shared/`, handler in `main/`, preload bridge, and renderer call  
- Bump patch version in affected `package.json` when changing package behavior  

See [AGENTS.md](./AGENTS.md) for repository conventions and contribution guidelines.

---

## Team backend (separate repository)

> **2026-10-11 变更**：桌面端团队工作区运行时已移除，本仓库内**没有** `server/` 目录，也不再包含团队后端。

团队后端维护在独立仓库（`profer-server`，Hono + better-sqlite3 + JWT），**不随本公开仓库发布**。如需自托管，请从该独立仓库获取部署说明。

---

## Community

- **GitHub Discussions**: [Ask questions, share workflows](https://github.com/Yuan-lai-ru-ci/ProferAI/discussions)  
- **Issues**: [Report bugs, request features](https://github.com/Yuan-lai-ru-ci/ProferAI/issues)  
- **PRs**: [Contribute code, docs, skills](https://github.com/Yuan-lai-ru-ci/ProferAI/pulls)  

---

## Roadmap

- [ ] Windows ARM64 support  
- [ ] Linux AppImage / Flatpak  
- [ ] Plugin API for third-party integrations  
- [ ] Built-in vector DB for semantic search over workspace context  
- [ ] iOS client  
- [ ] Web version (WebAssembly agent runtime)  

See [open issues](https://github.com/Yuan-lai-ru-ci/ProferAI/issues) for detailed plans and vote on what matters to you.

---

## License

Profer is built on [Proma](https://github.com/ErlichLiu/Proma) and licensed under [AGPL-3.0](./LICENSE).  

Commercial licensing available for teams needing proprietary forks—contact us via Issues.

---

## Credits

Built with:

- [Proma](https://github.com/ErlichLiu/Proma) by Erlich Liu  
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) by Anthropic  
- [Pi Agent SDK](https://www.npmjs.com/package/@earendil-works/pi-agent-core) by Earendil Works  
- [Shiki](https://shiki.style/), [Beautiful Mermaid](https://www.npmjs.com/package/@cuhery/beautiful-mermaid), [Cherry Studio](https://github.com/kangfenmao/cherry-studio), [Lobe Icons](https://lobehub.com/icons)  

---

<div align="center">

**[⬇️ Download Profer](https://github.com/Yuan-lai-ru-ci/ProferAI/releases)** · **[📖 Read the docs](./docs)** · **[⭐ Star this repo](https://github.com/Yuan-lai-ru-ci/ProferAI)**

Made with ❤️ by the Profer team

</div>
