/**
 * AgentHeader — Agent 会话的插件任务控件。
 *
 * 会话标题与重命名入口已完全收敛到顶部 TabBar，内容区不再保留重复标题占位；
 * 这里只承载第三方插件的任务控件（模型路由与插件侧面板入口）。
 */

import * as React from 'react'
import { PluginTaskControls } from '@/components/plugins/PluginTaskControls'

interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  return <PluginTaskControls kind="agent" sessionId={sessionId} />
}
