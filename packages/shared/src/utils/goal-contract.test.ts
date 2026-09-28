import { describe, expect, test } from 'bun:test'
import { isGoalIterationMessage, isGoalUpdateToolName, parseGoalCommand, parseGoalContractInput, stripGoalResultBlocks } from './goal-contract'

describe('goal contract parsing', () => {
  test('parses subcommands case-insensitively', () => {
    expect(parseGoalCommand('/goal STATUS')).toEqual({ type: 'status' })
    expect(parseGoalCommand('/goal resume')).toEqual({ type: 'resume' })
  })

  test('subcommand inside a multiline goal stays a start command', () => {
    const command = parseGoalCommand('/goal status 页面重做\n把旧状态页替换成新设计')
    expect(command.type).toBe('start')
    if (command.type === 'start') expect(command.goal).toContain('status 页面重做')
  })

  test('contract markers are extracted and removed from the goal text', () => {
    const { goal, contract } = parseGoalContractInput('优化首屏加载\n@verify: LCP < 2s\n@constraints: 不动鉴权逻辑\n@stop: 需要生产数据时')
    expect(goal).toBe('优化首屏加载')
    expect(contract).toEqual({ verification: 'LCP < 2s', constraints: '不动鉴权逻辑', stopWhen: '需要生产数据时' })
  })

  test('duplicate or overlong markers keep the first valid value', () => {
    const long = 'x'.repeat(241)
    const { contract } = parseGoalContractInput(`目标\n@verify: ${long}\n@verify: 第一条有效\n@verify: 第二条忽略`)
    expect(contract?.verification).toBe('第一条有效')
  })

  test('goal without markers has no contract', () => {
    expect(parseGoalContractInput('优化性能').contract).toBeUndefined()
    expect(parseGoalCommand('/goal 优化性能')).toEqual({ type: 'start', goal: '优化性能', contract: undefined })
  })

  test('stripGoalResultBlocks removes machine protocol from display text', () => {
    const text = '本轮完成了修改。\n\n<goal_result>{"status":"continue","summary":"x","evidence":[]}</goal_result>\n'
    expect(stripGoalResultBlocks(text)).toBe('本轮完成了修改。')
    // 未闭合的尾部块（流式中途）一并剥离
    expect(stripGoalResultBlocks('正文<goal_result>{"stat')).toBe('正文')
    expect(stripGoalResultBlocks('没有协议块的文本')).toBe('没有协议块的文本')
  })

  test('isGoalIterationMessage only matches marked messages', () => {
    expect(isGoalIterationMessage({ type: 'user', _goalIteration: 3 })).toBe(true)
    expect(isGoalIterationMessage({ type: 'user', _goalIteration: true })).toBe(true)
    expect(isGoalIterationMessage({ type: 'user' })).toBe(false)
    expect(isGoalIterationMessage(null)).toBe(false)
  })

  test('isGoalUpdateToolName recognizes Claude MCP and Pi names', () => {
    expect(isGoalUpdateToolName('update_goal')).toBe(true)
    expect(isGoalUpdateToolName('mcp__goal__update_goal')).toBe(true)
    expect(isGoalUpdateToolName('mcp__planning__update_todo')).toBe(false)
  })
})
