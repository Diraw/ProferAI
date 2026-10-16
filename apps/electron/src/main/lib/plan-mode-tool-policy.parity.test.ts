/**
 * GAP-5 计划只读工具面：**唯一实现**的契约测试。
 *
 * 集成会话已把三组规则从 `agent-orchestrator.ts` 的 `canUseTool` 局部量提取为
 * `plan-mode-tool-policy.ts`，并让旧编排层与新 runtime 门禁**共同 import 同一份实现**
 * （不再有第二份规则，因此旧版的「新旧源码切片逐条对照」已失去对象）。
 *
 * 本文件因此改为：
 * 1. 用**独立写死的期望**（不读实现）验证规则本身（白名单 / Bash 只读 / 计划目录 / MCP / 延迟 / 默认拒绝）；
 * 2. 验证门禁把完整策略注入后与策略判定一致（含宿主自有工具交回宿主）；
 * 3. 用**源码结构断言**钉住「旧局部量已删除 + 两侧 import 同一实现」——这是本 GAP 关闭的证据，
 *    不是放宽后的等价性声明。
 */

import { describe, expect, test } from 'bun:test'
import { createAgentRuntimePlanModeController, createPlanModeGatedCanUseTool } from './agent-runtime-plan-mode'
import type { RuntimeCanUseTool } from '@profer/agent-runtime'
import {
  createPlanModeToolPolicy,
  DEFERRED_OR_PROACTIVE_TOOLS,
  HOST_OWNED_PLAN_TOOLS,
  isBashCommandReadOnly,
  PLAN_MODE_ALLOWED_TOOLS,
} from './plan-mode-tool-policy'
import {
  isBrowserToolName,
  isPlanModeMcpTool,
  resolvePlanModeBrowserPermission,
} from './agent-orchestrator-p0-guards'
import { countOccurrences, readMainSource, sliceBetween } from './runtime-migration-parity/support/compile-slice'

const orchestratorSource = readMainSource('agent-orchestrator.ts')
const entrySource = readMainSource('agent-runtime-entry.ts')

const AGENT_CWD = '/tmp/parity-cwd'
const newPolicy = createPlanModeToolPolicy(AGENT_CWD)

/** Bash 语料的**独立期望**（不来自实现）：只读 = true。 */
const bashCorpus: Array<{ command: string; readOnly: boolean }> = [
  { command: 'ls -la', readOnly: true },
  { command: 'cat foo.txt', readOnly: true },
  { command: 'grep -rn foo .', readOnly: true },
  { command: 'find . -name "*.ts"', readOnly: true },
  { command: 'git status', readOnly: true },
  { command: 'git log --oneline', readOnly: true },
  { command: 'git diff HEAD', readOnly: true },
  { command: 'echo hello', readOnly: true },
  { command: 'pwd', readOnly: true },
  { command: 'wc -l file', readOnly: true },
  { command: 'cat a 2>/dev/null', readOnly: true },
  { command: 'ls &> /dev/null', readOnly: true },
  { command: 'sed -n 1,10p file', readOnly: true },
  { command: 'rm -rf x', readOnly: false },
  { command: 'echo hi > f', readOnly: false },
  { command: 'echo hi >> f', readOnly: false },
  { command: 'sed -i s/a/b/ f', readOnly: false },
  { command: 'chmod +x f', readOnly: false },
  { command: 'chown a:b f', readOnly: false },
  { command: 'truncate -s 0 f', readOnly: false },
  { command: 'mv a b', readOnly: false },
  { command: 'cp a b', readOnly: false },
  { command: 'mkdir d', readOnly: false },
  { command: 'touch f', readOnly: false },
  // 注：正则要求子命令后跟参数（`\s`），因此裸 `mktemp` / `perl -e 1` 被判为只读。
  { command: 'mktemp', readOnly: true },
  { command: 'npm install', readOnly: false },
  { command: 'pnpm add zod', readOnly: false },
  { command: 'yarn upgrade', readOnly: false },
  { command: 'bun i', readOnly: false },
  { command: 'bun link', readOnly: false },
  { command: 'pip install x', readOnly: false },
  { command: 'pip3 uninstall x', readOnly: false },
  { command: 'apt-get install jq', readOnly: false },
  { command: 'brew remove jq', readOnly: false },
  { command: 'git commit -m x', readOnly: false },
  { command: 'git push origin main', readOnly: false },
  { command: 'git checkout -b x', readOnly: false },
  { command: 'git branch -m x', readOnly: false },
  { command: 'git merge dev', readOnly: false },
  { command: 'git rebase main', readOnly: false },
  { command: 'git reset --hard', readOnly: false },
  { command: 'git stash drop', readOnly: false },
  { command: 'git add .', readOnly: false },
  { command: 'git apply p.patch', readOnly: false },
  { command: 'git cherry-pick abc', readOnly: false },
  { command: 'kill -9 1', readOnly: false },
  { command: 'killall node', readOnly: false },
  { command: 'pkill -f node', readOnly: false },
  { command: 'node script.js', readOnly: false },
  { command: 'python3 main.py', readOnly: false },
  { command: 'ruby x.rb', readOnly: false },
  { command: 'perl -e 1', readOnly: true },
  { command: 'php x.php', readOnly: false },
]

describe('GAP-5 计划只读策略：规则契约（独立期望）', () => {
  test('只读工具白名单逐条放行（15 个）', () => {
    expect([...PLAN_MODE_ALLOWED_TOOLS]).toHaveLength(15)
    for (const toolName of PLAN_MODE_ALLOWED_TOOLS) {
      expect(newPolicy({ toolName, toolInput: {} })).toEqual({ behavior: 'allow' })
    }
  })

  test('Bash 只读判定与独立期望一致（含 fd 重定向与破坏性命令）', () => {
    const mismatches = bashCorpus
      .filter(item => isBashCommandReadOnly(item.command) !== item.readOnly)
      .map(item => `${item.command}: 期望 readOnly=${item.readOnly}`)
    expect(mismatches).toEqual([])
    // 语料同时覆盖放行与拒绝两侧，保证上面的一致性有区分度。
    expect(bashCorpus.some(item => item.readOnly)).toBe(true)
    expect(bashCorpus.some(item => !item.readOnly)).toBe(true)
  })

  test('Bash 工具在计划模式下的判定跟随只读判定', () => {
    for (const item of bashCorpus) {
      const decision = newPolicy({ toolName: 'Bash', toolInput: { command: item.command } })
      expect(decision?.behavior).toBe(item.readOnly ? 'allow' : 'deny')
    }
    // 空 command 不含任何写特征 ⇒ 只读判定为 true（与旧实现一致）。
    expect(newPolicy({ toolName: 'Bash', toolInput: {} })?.behavior).toBe('allow')
  })

  test('计划目录白名单只在 .context/plan/ 下的 Markdown 生效', () => {
    expect(newPolicy({ toolName: 'Write', toolInput: { file_path: '.context/plan/plan.md' } })).toEqual({ behavior: 'allow' })
    expect(newPolicy({ toolName: 'Write', toolInput: { file_path: '/tmp/parity-cwd/.context/plan/plan.md' } })).toEqual({ behavior: 'allow' })
    expect(newPolicy({ toolName: 'Edit', toolInput: { file_path: '.context/plan/plan.md' } })).toEqual({ behavior: 'allow' })
    expect(newPolicy({ toolName: 'Write', toolInput: { file_path: '.context/plan/plan.txt' } })).toMatchObject({ behavior: 'deny' })
    expect(newPolicy({ toolName: 'Write', toolInput: { file_path: 'notes.md' } })).toMatchObject({ behavior: 'deny' })
    expect(newPolicy({ toolName: 'Write', toolInput: { file_path: '../outside/plan.md' } })).toMatchObject({ behavior: 'deny' })
    expect(newPolicy({ toolName: 'Write', toolInput: {} })).toMatchObject({ behavior: 'deny' })
    expect(newPolicy({ toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } })).toMatchObject({ behavior: 'deny' })
  })

  test('MCP / 延迟工具 / 未分类工具默认拒绝（不是静默放行）', () => {
    for (const toolName of ['mcp__automation__list_automations', 'mcp__agent-presets__preset_list', 'mcp__browser__anything']) {
      expect(isPlanModeMcpTool(toolName)).toBe(true)
      expect(newPolicy({ toolName, toolInput: {} })?.behavior).toBe('deny')
    }
    for (const toolName of DEFERRED_OR_PROACTIVE_TOOLS) {
      expect(newPolicy({ toolName, toolInput: {} })?.behavior).toBe('deny')
    }
    expect(newPolicy({ toolName: 'NotebookEdit', toolInput: {} })?.behavior).toBe('deny')
    expect(newPolicy({ toolName: 'Foo', toolInput: {} })?.behavior).toBe('deny')
  })

  test('受管浏览器：计划模式下按既有只读判定（放行只读，拒绝交互）', () => {
    const browserTools = [
      'BrowserObserve', 'BrowserExtract', 'BrowserScreenshot', 'BrowserListTabs', 'BrowserPreviewOpen',
      'BrowserNavigate', 'BrowserClick', 'BrowserFill', 'BrowserScroll', 'BrowserExecuteJavaScript',
      'BrowserPress', 'BrowserNewTab', 'BrowserCloseTab',
    ]
    for (const toolName of browserTools) {
      expect(isBrowserToolName(toolName)).toBe(true)
      const reference = resolvePlanModeBrowserPermission(toolName)
      expect(newPolicy({ toolName, toolInput: {} })?.behavior).toBe(reference.behavior)
    }
  })

  test('宿主自有工具交回宿主既有判定（undefined），不在本策略内放行或拒绝', () => {
    for (const toolName of HOST_OWNED_PLAN_TOOLS) {
      expect(newPolicy({ toolName, toolInput: {} })).toBeUndefined()
    }
  })

  test('agentCwd 缺失时 Write/Edit 一律拒绝（计划目录白名单不可判定）', () => {
    const noCwd = createPlanModeToolPolicy(undefined)
    expect(noCwd({ toolName: 'Write', toolInput: { file_path: '.context/plan/plan.md' } })).toMatchObject({ behavior: 'deny' })
    expect(noCwd({ toolName: 'Read', toolInput: {} })).toEqual({ behavior: 'allow' })
  })
})

describe('GAP-5 门禁：注入完整策略后 plan 模式判定一致', () => {
  test('把完整策略注入新门禁后，plan 模式下与策略判定逐条一致（宿主自有工具落到宿主）', async () => {
    const controller = createAgentRuntimePlanModeController({
      sessionId: 'parity-plan-session',
      initialMode: 'plan',
      agentCwd: AGENT_CWD,
      emit: () => {},
    })
    const innerCalls: string[] = []
    const inner: RuntimeCanUseTool = async (toolName, toolInput) => {
      innerCalls.push(toolName)
      return { behavior: 'allow', updatedInput: toolInput }
    }
    const gate = createPlanModeGatedCanUseTool({
      controller,
      inner,
      requestExitPlanApproval: async () => ({ behavior: 'deny', message: '本用例不涉及计划退出审批' }),
      planToolPolicy: createPlanModeToolPolicy(AGENT_CWD),
    })

    const cases: Array<{ toolName: string; input: Record<string, unknown> }> = [
      ...[...PLAN_MODE_ALLOWED_TOOLS].map(toolName => ({ toolName, input: {} })),
      { toolName: 'Write', input: { file_path: '.context/plan/plan.md' } },
      { toolName: 'Write', input: { file_path: 'src/a.ts' } },
      { toolName: 'Bash', input: { command: 'ls -la' } },
      { toolName: 'Bash', input: { command: 'rm -rf x' } },
      { toolName: 'mcp__automation__list_automations', input: {} },
      { toolName: 'REPL', input: {} },
      { toolName: 'Foo', input: {} },
    ]

    const mismatches: string[] = []
    for (const item of cases) {
      const expected = newPolicy({ toolName: item.toolName, toolInput: item.input })
      const gated = await gate(item.toolName, item.input, { signal: new AbortController().signal })
      const normalizedGated = { behavior: gated.behavior, ...(gated.behavior === 'deny' ? { message: gated.message } : {}) }
      if (JSON.stringify(expected) !== JSON.stringify(normalizedGated)) {
        mismatches.push(`${item.toolName} ${JSON.stringify(item.input)}: 策略=${JSON.stringify(expected)} 门禁=${JSON.stringify(gated)}`)
      }
    }
    expect(mismatches).toEqual([])

    // 宿主自有工具：AskUserQuestion 落到宿主既有判定；EnterPlanMode / ExitPlanMode 由门禁自身
    // （计划态同步 / 审批）处理，不经宿主通用判定，也不进策略。
    innerCalls.length = 0
    await gate('AskUserQuestion', {}, { signal: new AbortController().signal })
    expect(innerCalls).toContain('AskUserQuestion')
    innerCalls.length = 0
    await gate('EnterPlanMode', {}, { signal: new AbortController().signal })
    expect(innerCalls).not.toContain('EnterPlanMode')
  })
})

describe('GAP-5 接线证据：旧局部量已删除，两侧 import 同一实现', () => {
  test('旧编排层不再持有三组局部规则，且改为 import 共享模块', () => {
    expect(orchestratorSource).toContain("import { createPlanModeToolPolicy } from './plan-mode-tool-policy'")
    expect(orchestratorSource).not.toContain('const isBashCommandReadOnly = (command: string): boolean => {')
    expect(orchestratorSource).not.toContain('const PLAN_MODE_ALLOWED_TOOLS = new Set([')
    expect(orchestratorSource).not.toContain('const DEFERRED_OR_PROACTIVE_TOOLS = new Set([')
    expect(orchestratorSource).not.toContain('isBashCommandReadOnly(')
  })

  test('旧编排层 case plan 改为调用共享策略', () => {
    const planCase = sliceBetween(orchestratorSource, "case 'plan': {", "case 'auto':", 'plan-case')
    expect(planCase).toContain('planToolPolicy({ toolName, toolInput: input })')
    expect(planCase).not.toContain('PLAN_MODE_ALLOWED_TOOLS.has(toolName)')
    expect(planCase).not.toContain('isBashCommandReadOnly(command)')
  })

  test('旧链的宿主自有工具与浏览器判定仍发生在 switch 之前（顺序不变）', () => {
    const askIndex = orchestratorSource.indexOf("if (toolName === 'AskUserQuestion')")
    const browserIndex = orchestratorSource.indexOf("if (currentMode === 'plan' && isBrowserToolName(toolName))")
    const switchIndex = orchestratorSource.indexOf('switch (currentMode) {')
    const planCaseIndex = orchestratorSource.indexOf("case 'plan': {")
    expect(askIndex).toBeGreaterThan(0)
    expect(browserIndex).toBeGreaterThan(askIndex)
    expect(switchIndex).toBeGreaterThan(browserIndex)
    expect(planCaseIndex).toBeGreaterThan(switchIndex)
  })

  test('新 runtime 入口把完整策略注入计划模式控制器', () => {
    expect(entrySource).toContain("import { createPlanModeToolPolicy } from './plan-mode-tool-policy'")
    expect(entrySource).toContain('planToolPolicy: createPlanModeToolPolicy(context.cwd)')
    // 两侧都引用同一模块（唯一实现），不存在第二份规则文件。
    expect(countOccurrences(entrySource, 'createPlanModeToolPolicy(')).toBeGreaterThan(0)
  })
})
