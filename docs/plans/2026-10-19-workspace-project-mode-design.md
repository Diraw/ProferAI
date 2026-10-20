# 工作区项目模式（Project Mode）设计

> 日期：2026-10-19（GMT+8）
> 状态：设计草案，待评审；本文不含代码改动
> 范围：把「工作区」从应用内虚拟目录改造为「绑定真实项目文件夹 + 项目内 `.profer/` 配置容器」
> 非范围：团队工作区云同步协议、Agent 并发 worktree、项目模板市场

## 1. 背景

当前 Profer 的「工作区」是纯应用内概念：

- 索引只有 `id / name / slug / type`，**没有路径字段**（`packages/shared/src/types/agent.ts`）；
- 目录固定为 `~/.profer/agent-workspaces/<slug>/`（开发版 `~/.profer-dev/`）；
- Agent 的 cwd 是 `~/.profer/agent-workspaces/<slug>/<sessionId>/`（`config-paths.ts#getAgentSessionWorkspacePath`）；
- 用户真实项目只能作为「附加目录」出现，靠绝对路径读写；
- 删除工作区会 `rm -rf` 整个目录（`agent-workspace-manager.ts#deleteAgentWorkspace`）。

这带来三个结构性问题：

1. **Agent 不在项目里工作**：相对路径、`git status`、构建命令都落在会话沙箱，用户项目是「外部目录」。
2. **配置不可携带**：profile、memory、skills、mcp、presets 都锁在 `~/.profer`，换机器、团队共享、随仓库版本化都做不到。
3. **「工作区」与「项目」语义分裂**：应用里叫项目，磁盘上是配置目录，用户无法用 Finder 直接对应。

目标形态对齐 Claude Code / Cursor：**一个真实文件夹 = 一个项目，项目内 `.profer/` 承载可协作配置，Agent 直接在该文件夹工作。**

## 2. 现状事实（改造前核对）

| 项 | 事实 | 代码位置 |
|---|---|---|
| 索引版本 | v3，字段 `id/name/slug/type/archived/...` | `agent-workspace-manager.ts` |
| 工作区根 | `~/.profer/agent-workspaces/<slug>/`，首次访问自动 mkdir | `config-paths.ts#getAgentWorkspacePath` |
| 会话 cwd | `<工作区根>/<sessionId>/`，有 parity 测试禁止退化为工作区根 | `agent-runtime-cwd-isolation.parity.test.ts` |
| 附加目录 | `collectAttachedDirectories` 聚合 session extraDirs / attached / 工作区根 / workspace-files | `agent-directory-utils.ts` |
| 文件监听 | 递归监听整个 `agent-workspaces/`，跳过 node_modules 等噪声目录 | `workspace-watcher.ts` |
| 删除 | 删除索引条目并 `rmSync` 工作区目录 | `agent-workspace-manager.ts` |
| 团队工作区 | `slug = team-<id>`，数据在云端，本地无项目概念 | `agent-workspaces.json` |
| 路径函数调用面 | `agent-workspace-manager.ts` 44 处、`migration-service.ts` 28 处，另有全局技能、IPC、桥接、预览等 | `grep getAgentWorkspacePath` |

`getAgentWorkspacePath(slug)` 是「slug 即路径」的隐式契约，这是本次改造真正的工程量所在。

## 3. 概念模型：拆成四层

| 层 | 定义 | 项目模式归属 |
|---|---|---|
| L1 项目 | 用户选定的真实文件夹（`rootPath`） | 用户磁盘，Profer 只记录路径 |
| L2 配置容器 | profile / memory / skills / mcp / presets / workspace-files | `<root>/.profer/` |
| L3 执行目录 | Agent 的 cwd 与相对路径基准 | `<root>`（项目根） |
| L4 会话数据 | 消息、checkpoint、附件、blobs、索引 | `~/.profer/`（中央，不随项目走） |

核心判断：**只有 L2 进项目，L4 永远留中央。** 理由：

- 会话数据体积大（单个工作区可到数百 MB），进项目会污染 git、拖慢 clone；
- 会话含隐私内容，不应默认随仓库共享；
- 会话索引需要跨项目检索，放项目内会退化成「每仓库一个孤岛」；
- L2 是「换机器就生效」的配置资产，才值得版本化。

## 4. 目录布局

### 4.1 项目模式

```text
/Users/mac/src/my-project/
├── .profer/
│   ├── profile.md              # 工作区资料（原 workspace-profile.md）
│   ├── memory/
│   │   ├── MEMORY.md           # 索引
│   │   └── archive/            # 正文
│   ├── skills/                 # 项目级技能
│   ├── skills-inactive/        # 停用技能
│   ├── mcp.json                # 项目 MCP
│   ├── agent-presets.json      # 项目预设
│   ├── workspace-files/        # 调研、证据、产物
│   ├── sessions/               # 仅临时产物，默认 gitignore
│   ├── .gitignore
│   └── .lock                   # 多实例互斥（P2）
├── src/
└── package.json
```

### 4.2 中央目录（不变）

```text
~/.profer/
├── agent-workspaces.json       # 索引，新增 rootPath / storageMode
├── agent-sessions/             # 会话消息与元数据
├── agent-checkpoints/          # Pi checkpoint
├── blobs/  attachments/        # 附件与二进制
├── global-skills/              # 全局技能（跨项目）
├── channels.json  auth-tokens.enc
└── agent-workspaces/<slug>/    # 仅 managed 模式仍使用
```

### 4.3 默认 `.profer/.gitignore`

```gitignore
sessions/
.cache/
*.local.json
.lock
```

`profile.md`、`memory/` 默认**不**忽略，但首次生成时提示用户：不要写入凭据、token、过于私人的信息。`mcp.json` 若含密钥，建议改用 `${env:VAR}` 引用（schema 支持列为 P2）。

开发版与正式版共用项目内 `.profer`，不按 `.profer-dev` 分裂，避免同一项目出现两份配置。

## 5. 数据模型

### 5.1 类型变更

```ts
export type WorkspaceStorageMode = 'managed' | 'project'

export interface AgentWorkspace {
  // ...现有字段保持不变
  /** 项目模式：用户项目根绝对路径；managed 模式不落盘 */
  rootPath?: string
  /** 缺省视为 managed，保证旧数据零迁移 */
  storageMode?: WorkspaceStorageMode
}
```

### 5.2 索引 v3 → v4

- 为所有存量工作区补 `storageMode: 'managed'`（幂等）。
- `rootPath` 不做批量补写。
- 新增唯一性约束：同一 `rootPath`（`realpath` 归一化、大小写按平台处理）只允许一个工作区。
- 索引写入前校验：`project` 模式必须有 `rootPath`；`managed` 模式不得有 `rootPath`。

### 5.3 语义约束

- `slug` 继续存在，但**不再是路径来源**，只作为内部稳定 ID / 兼容键。
- `name` 可与文件夹名不同，允许用户重命名显示名。
- `rootPath` 一旦绑定不可静默变更；改路径必须走「重新定位」显式操作。

## 6. 路径解析契约

新增纯模块 `apps/electron/src/main/lib/workspace-locator.ts`：

```ts
export interface WorkspaceLocation {
  /** L2 配置容器：managed = ~/.profer/agent-workspaces/<slug>，project = <root>/.profer */
  configDir: string
  /** L3 执行根：managed = configDir，project = rootPath */
  rootPath: string
  mode: WorkspaceStorageMode
}

export function resolveWorkspaceLocation(slug: string): WorkspaceLocation
export function invalidateWorkspaceLocation(slug?: string): void
```

设计要点：

1. **locator 自己读索引**，只依赖 `getConfigDir()`，不依赖 `agent-workspace-manager`，避免循环依赖。
2. 进程内缓存 `slug → location`，工作区增删改时由 manager 调用 `invalidate`。
3. `config-paths.ts` 的 workspace 级函数（`getWorkspaceMcpPath`、`getWorkspaceSkillsDir`、`getInactiveSkillsDir`、`getWorkspaceAgentPresetsPath`、`getWorkspaceFilesDir`、profile/memory 路径）内部改为走 locator，**对外签名保持 `(slug)` 不变**。
4. `getAgentWorkspacePath(slug)` 保留，语义改为 `configDir`；新增 `getWorkspaceRootPath(slug)` 返回 L3 根。
5. mkdir 副作用只允许作用于 `configDir`；`rootPath` 不存在时**绝不自动创建**，抛 `WorkspaceRootMissingError`。

这一层做完，90% 调用点无需修改；只有需要「项目根语义」的地方显式改用 `getWorkspaceRootPath`。

## 7. 执行目录（cwd）语义

### 7.1 规则

| 模式 | 会话 cwd | 说明 |
|---|---|---|
| `project` | `rootPath` | 与 Claude Code 一致，相对路径直接落在项目 |
| `managed` | `<configDir>/<sessionId>` | 维持现状，parity 测试继续生效 |
| 无工作区 | 用户主目录 | 维持现状 |

### 7.2 为什么不保留会话子目录

会话子目录隔离解决的是「并发会话互相踩文件」。但代价是 Agent 永远不在项目根，`./report.md` 不进项目，`git status` 看到的不是用户仓库。对「在项目里干活」的产品目标，这个代价不可接受。

并发改为分层兜底：

1. **第一阶段**：同项目多会话共享 cwd，靠用户/Agent 自觉与 git 分支持续兜底；会话之间的临时文件约定写到 `.profer/sessions/<sessionId>/`。
2. **第二阶段（P4）**：引入 git worktree 隔离，每个会话可选独立 worktree，彻底消除写冲突。

### 7.3 parity 测试的处置

`agent-runtime-cwd-isolation.parity.test.ts` 不能删除，改为按 `storageMode` 分叉断言：

- `managed`：cwd 必须等于 `<configDir>/<sessionId>`，禁止退化为 configDir；
- `project`：cwd 必须等于 `rootPath`，且同一项目两个会话 cwd 相同（这是**预期行为**，需显式断言，防止未来误改回子目录）。

### 7.4 checkpoint 与临时产物

- Pi checkpoint 保持在中央 `~/.profer/agent-checkpoints/`，按 sessionId 隔离，不进项目。
- 项目模式不再把会话目录当作工作台；`sessions/<id>/` 仅存放用户显式要求「放在项目内的临时产物」，默认 gitignore。
- 现有 managed 会话的历史目录原样保留，不做搬迁。

## 8. 完整生命周期

### 8.1 创建项目模式工作区

1. 用户选择文件夹（系统目录选择器，复用现有授权目录入口）。
2. 校验：存在、是目录、可读写、不是文件系统根、不在 `~/.profer` / `~/.profer-dev` 内、不是已有工作区的 `rootPath`。
3. 若 `<root>/.profer` 已存在 → 走「打开已有项目」而非覆盖。
4. 生成 `.profer` 骨架：`profile.md`、`memory/MEMORY.md`、`skills/`、`mcp.json`（空结构）、`agent-presets.json`（空结构）、`workspace-files/`、`.gitignore`。
5. 写索引（`storageMode: 'project'`，`rootPath` 为 `realpath` 结果）。
6. 失败回滚：只清理本次新建的 `.profer` 内文件，**绝不删除项目内其他内容**。

### 8.2 打开已有项目

识别 `<root>/.profer` 是否存在，存在即复用配置；缺失的条目按骨架补齐，已存在的文件不覆盖。UI 标注「已识别 Profer 配置」。

### 8.3 绑定（managed → project）

1. 用户选择目标文件夹。
2. 预检：目标 `.profer` 是否已有内容；有冲突则列出清单，要求选择「合并 / 取消」。
3. 复制配置资产（profile、memory、skills、skills-inactive、mcp.json、presets、workspace-files），**不复制会话数据**。
4. 原 `~/.profer/agent-workspaces/<slug>/` 重命名为 `<slug>.migrated-<ts>` 作为回滚备份，不立即删除。
5. 索引切换 `storageMode` 与 `rootPath`；会话历史仍指向原 workspaceId，不受影响。

### 8.4 移除与删除

| 操作 | 行为 |
|---|---|
| 从 Profer 移除（project） | 仅删索引条目；项目文件与 `.profer` 全部保留；可随时重新打开 |
| 删除 `.profer` 配置 | 独立操作，二次确认，校验路径必须位于项目根内；默认保留 `profile.md` 与 `memory/`，需勾选才删 |
| 删除工作区（managed） | 维持现状：删索引 + 删目录 |
| 归档 / 收纳 | 两种模式一致，只改索引状态，不动磁盘 |

硬性红线：**项目模式下任何路径都不能出现对 `rootPath` 本身的递归删除。** 删除函数需按 `storageMode` 分支，并有单测断言项目内文件在移除后仍存在。

### 8.5 路径失效

- 启动时与打开工作区时 `stat(rootPath)`。
- 失效状态不落盘为破坏性字段，UI 显示「项目路径不可用」并提供「重新定位 / 从列表移除」。
- 失效期间禁止在该工作区新建会话，避免在错误路径重建目录。

## 9. 文件监听与文件浏览器

- 项目模式只监听 `<root>/.profer`（递归，跳过 `sessions/`），不再递归监听整个项目源码树。
- 项目源码变化交给现有 git diff / 预览链路，不进入 `WORKSPACE_FILES_CHANGED` 事件流。
- `workspace-watcher.ts` 的根目录 watcher 需要支持「多根」：`agent-workspaces/`（managed）+ 每个 project 的 `.profer`。
- 文件浏览器默认根从 configDir 改为 rootPath，`.profer` 作为可展开节点；仍遵守现有路径越界校验。

## 10. 权限与提示词

### 10.1 授权目录

- `collectAttachedDirectories` 在 project 模式下加入 `rootPath`，不再重复加入 configDir（它已在 rootPath 内）。
- 敏感文件规则不变：`.env`、`.git/config`、凭据文件仍按现有策略处理，不因 cwd 变化放开。
- 预览与附件路径校验继续使用 `realpath`，防止符号链接越界。

### 10.2 提示词

- 工作区路径声明改为 `rootPath`，并明确「当前目录即项目根」。
- 移除「工作区根 vs 会话目录」的双路径说明，减少 Agent 误判。
- `projectCandidates` 探测在 project 模式下直接使用 rootPath，不再从附加目录反推。

## 11. 迁移与兼容

| 场景 | 策略 |
|---|---|
| 存量个人工作区 | 保持 managed，索引补字段，零文件移动 |
| 存量团队工作区 | 固定 managed，不参与本轮；云同步模型未定义 rootPath 冲突 |
| 存量会话 | 不动；managed 会话 cwd 规则不变 |
| 新工作区 | 默认 project（功能开关打开后）；开关关闭时仍可建 managed |
| 跨设备 | `.profer` 随 git 走，另一台机器「打开项目」即复用配置；会话历史不跟随 |
| 回滚 | 关闭开关 + 忽略 `storageMode` 即回到旧行为；已绑定的项目需手动移除索引后重建 |

功能开关：`workspace.projectMode.enabled`，默认关闭，P1 验收通过后打开。开关只影响新建入口与 cwd 解析，不影响已存在数据。

## 12. 分期与验收

### P0 契约与路径收口（2–3 天）

- 类型字段、索引 v4、`workspace-locator`、`config-paths` 内部切换、`invalidate` 接线。
- 不改任何行为，不改 UI。
- 验收：全量测试通过；存量工作区路径、技能、预设、会话 cwd 与改造前逐项一致。

### P1 项目模式核心（2–3 天）

- 创建 / 打开 / 绑定 / 移除、cwd 切换、删除语义、rootMissing。
- 验收：
  1. 新建项目会话 `pwd` 返回项目根；
  2. managed 会话 cwd 不变；
  3. 移除工作区后项目文件与 `.profer` 均存在；
  4. 同一文件夹不能重复绑定；
  5. 路径被移动后 UI 显示失效且不重建目录。

### P2 配置资产与监听（3–4 天）

- profile / memory / skills / mcp / presets / workspace-files 读写全部走 `.profer`；watcher 多根；文件浏览器。
- 验收：项目内技能、预设、MCP 生效且重启后保持；`.profer` 外文件不触发工作区事件；多实例锁生效。

### P3 UI 与迁移向导（2–3 天）

- 项目切换器显示路径、失效提示、绑定迁移向导、首次创建隐私提示、模板。

### P4 并发与团队（独立评估）

- git worktree 会话隔离；团队工作区的 rootPath 模型与同步协议。

合计 P0–P3 约 **9–13 个工作日**（单人，含回归），不含 P4。

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 删除语义写错 | 删掉用户代码 | 按模式分支 + 单测断言；项目模式禁止递归删除 rootPath |
| cwd 隔离回归 | remote/automation 会话串线 | parity 测试按模式分叉，保留 managed 断言 |
| 路径函数遗漏 | 部分功能仍写中央目录 | locator 统一收口；grep 审计 `agent-workspaces` 硬编码 |
| watcher 事件风暴 | CPU 飙高、IPC 刷屏 | 只 watch `.profer`，跳过 sessions 与噪声目录 |
| skills/presets slug 假定 | 项目模式找不到技能 | 路径全部走 locator；补跨工作区引用测试 |
| `.profer` 进 git 泄露 | 隐私与密钥 | 默认 gitignore 敏感子目录；首次创建提示；`${env:VAR}` 支持 |
| Windows 路径差异 | 大小写、长路径、符号链接 | `realpath` 归一化；路径比较按平台处理；CI 覆盖 win32 单测 |
| 多实例同时打开 | 配置写冲突 | `.profer/.lock` + 写入前校验（P2） |

## 14. 待决问题

1. **项目名与文件夹名**：默认取文件夹名，允许改显示名；是否允许同名不同路径并存？（建议允许，UI 显示路径区分）
2. **monorepo 子目录**：rootPath 允许指向子目录，`.profer` 建在子目录；是否需要「向上查找已有 .profer」？（建议 P3 再加）
3. **团队工作区**：是否长期保持 managed，还是未来也绑定本地 clone？（建议保持 managed，等同步协议单独立项）
4. **会话临时产物**：`.profer/sessions/` 是否保留，还是全部走系统临时目录？（建议保留，便于用户找回）
5. **默认模式**：开关打开后，新建默认 project 还是让用户每次选择？（建议首次引导选择，之后记住偏好）

## 15. 一句话结论

这次改造的本质不是「加一个 `.profer` 文件夹」，而是把「工作区」从**应用内沙箱**改造成**项目的一个视图**。只要守住两条边界——L2 配置进项目、L4 会话留中央，以及一条红线——项目模式下永不删除项目目录，工程量可控制在两周内，且可以按 P0→P3 逐段验收、随时回滚。
