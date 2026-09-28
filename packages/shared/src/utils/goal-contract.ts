import type { AgentGoalCommand, AgentGoalContract } from '../types/agent'

const GOAL_SUBCOMMANDS = ['status', 'pause', 'resume', 'stop', 'clear'] as const

/**
 * 解析 `/goal` 输入（renderer 与 main 共用的唯一实现）。
 * 支持 Codex 式契约行标记（沿用 pi-harness @verify/@artifact 的声明式行标记传统）：
 *   /goal 完成登录页
 *   @verify: pnpm test:e2e login 通过
 *   @constraint: 不修改支付相关代码
 *   @stop: 需要生产环境凭据时
 * 标记行不进入 goal 文本本身。
 */
export function parseGoalCommand(input: string): AgentGoalCommand {
  const trimmed = input.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return { type: 'not_goal' }
  const rest = trimmed.replace(/^\/goal\s*/i, '').trim()
  if (!rest) return { type: 'invalid', reason: '目标不能为空，例如：/goal 完成登录页' }
  const single = rest.toLowerCase()
  if (!rest.includes('\n') && (GOAL_SUBCOMMANDS as readonly string[]).includes(single)) {
    return { type: single as 'status' | 'pause' | 'resume' | 'stop' | 'clear' }
  }
  if (/^[a-z]+$/.test(single)) {
    return { type: 'invalid', reason: `未知的 Goal 命令：${rest}` }
  }
  const { goal, contract } = parseGoalContractInput(rest)
  if (!goal) return { type: 'invalid', reason: '目标不能为空，契约标记之外需要一行目标描述' }
  return { type: 'start', goal, contract }
}

/**
 * 从 `/goal` 正文中分离目标文本与契约标记。
 * 每类契约标记取第一条有效行（≤240 字符），其余行视为目标描述。
 */
export function parseGoalContractInput(text: string): { goal: string; contract?: AgentGoalContract } {
  const goalLines: string[] = []
  const contract: AgentGoalContract = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(/^@(verify|constraint|constraints|stop):\s*(\S.*)$/i)
    if (match) {
      const value = match[2]!.trim()
      if (value.length <= 240) {
        const kind = match[1]!.toLowerCase()
        if (kind === 'verify' && !contract.verification) contract.verification = value
        else if (kind.startsWith('constraint') && !contract.constraints) contract.constraints = value
        else if (kind === 'stop' && !contract.stopWhen) contract.stopWhen = value
      }
      continue
    }
    goalLines.push(rawLine)
  }
  const goal = goalLines.join('\n').trim()
  const hasContract = Boolean(contract.verification || contract.constraints || contract.stopWhen)
  return { goal, contract: hasContract ? contract : undefined }
}

/**
 * 从展示文本中剥离 <goal_result> 机器协议块。
 * Goal 迭代的结构化结果是控制器与模型的内部协议（main 侧从持久化原文解析），
 * 不应原文显示在对话里。未闭合的尾部块（流式中途）一并剥离。
 */
export function stripGoalResultBlocks(text: string): string {
  return text.replace(/<goal_result>[\s\S]*?(<\/goal_result>|$)/gi, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

export const GOAL_UPDATE_TOOL_NAME = 'update_goal'

/** Goal 内部状态工具不应作为普通工具过程展示。 */
export function isGoalUpdateToolName(name: unknown): boolean {
  return name === GOAL_UPDATE_TOOL_NAME || name === `mcp__goal__${GOAL_UPDATE_TOOL_NAME}`
}

/** 判断 SDK user 消息是否为 Goal 迭代注入的控制消息（带 _goalIteration 标记） */
export function isGoalIterationMessage(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as { _goalIteration?: unknown })._goalIteration != null)
}
