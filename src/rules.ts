// 注入给模型的短规则。只写行为，不写字段格式；格式由工具 schema 约束。

import type { Task } from "./state.ts"

export const RULES_TEXT = `## ai-dev-flow
- 变更类任务先调用 flow_submit_analysis；贴出稿件链接后调用 flow_confirm 弹第 1 张卡。
- 理解确认后调用 flow_submit_plan；贴出链接后调用 flow_confirm 弹第 2 张卡。清单确认后按清单自主执行。
- 问答和只读查询直接回答，不建任务、不弹卡。
- 执行中每完成一项调用 flow_progress 标 done；方案外实现细节先做、发现即报告；实质变更停下确认。
- 收尾调用 flow_finish，按证据核对交付说明。
- 确认前只读；写操作会被记录，请等两张卡都确认后再写。`

const LABEL: Record<Task["state"], string> = {
  analyzing: "理解中",
  awaiting_analysis: "待确认理解",
  planning: "清单中",
  awaiting_plan: "待确认清单",
  executing: "执行中",
  closed: "已结束",
}

export function statusLine(task: Task | undefined): string {
  if (!task) return "当前没有任务；问答和只读直接回答，变更类先调用 flow_submit_analysis。"
  const parts = [`任务 ${task.id}「${task.title}」${LABEL[task.state]}`]
  if (task.state === "awaiting_analysis" && task.currentAnalysis) parts.push(`稿件 ${task.currentAnalysis.path}`)
  if (task.state === "awaiting_plan" && task.currentPlan) parts.push(`清单 ${task.currentPlan.path}`)
  if (task.state === "executing") {
    const open = task.items.filter((item) => item.status !== "done")
    parts.push(`未完成 ${open.length} 项${open[0] ? `，下一项 ${open[0].id} ${open[0].title}` : ""}`)
    if (task.blockedOn) parts.push(`停在 ${task.blockedOn}`)
  }
  return parts.join("；")
}
