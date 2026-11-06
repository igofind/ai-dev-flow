// 确认工具：按任务状态弹第 1 或第 2 张卡，处理确认、取消和修正。

import { analysisCard, classifyAnswer, planCard } from "./cards.ts"
import { loadTask, saveTask, transition, type Task } from "./state.ts"

type Deps = {
  ctx: any
  session: { requireRoot: (context: any) => Promise<string> }
  cards: { create: (input: any) => Promise<string | undefined> }
  waiter: { wait: (formID: string) => Promise<any | undefined> }
  log: (message: string) => void
}

// 注册 confirm 工具：按任务状态弹第 1 或第 2 张卡并等待答复。
export async function registerConfirm({ ctx, session, cards, waiter, log }: Deps): Promise<void> {
  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "confirm",
      description: "为当前待确认的稿弹卡并等待答复：理解稿弹第 1 张卡，清单弹第 2 张卡。贴出稿件链接后再调用。",
      input: {
        type: "object",
        properties: { note: { type: "string", description: "可选的补充说明，不参与判定" } },
        additionalProperties: false,
      },
      options: { namespace: "flow" },
      execute: async (_input: any, context: any) => {
        const root = await session.requireRoot(context)
        const task = await loadTask(ctx, root)
        if (!task) throw new Error("没有任务：先提交理解与分析。")
        const stage = task.state === "awaiting_analysis" ? "analysis" : task.state === "awaiting_plan" ? "plan" : undefined
        if (!stage) throw new Error("当前没有待确认的稿。")
        if (stage === "analysis" && !task.currentAnalysis) throw new Error("理解稿记录缺失，请重新提交。")
        if (stage === "plan" && !task.currentPlan) throw new Error("清单记录缺失，请重新提交。")

        const spec = stage === "analysis" ? analysisCard(task) : planCard(task)
        const formID = await cards.create({ sessionID: root, ...spec })
        if (!formID) throw new Error("卡片没有弹出来（读不到本机服务）。")
        const answer = await waiter.wait(formID)
        if (!answer) throw new Error("卡片没有返回答复。")
        if (answer.cancelled) return { content: "卡片被关掉了，任务仍停在待确认。要执行就重新调用 flow_confirm。" }

        const verdict = classifyAnswer(String(answer.confirm ?? ""))
        if (verdict.kind === "invalid") throw new Error("卡片没有返回有效答复。")
        if (verdict.kind === "cancel") {
          const closed = transition(task, "closed")
          if (!closed.ok) throw new Error(closed.error)
          await saveTask(ctx, closed.task)
          return { content: `已取消任务 ${task.id}，不留任何授权。` }
        }
        if (verdict.kind === "revise") {
          const back = transition(task, stage === "analysis" ? "analyzing" : "planning")
          if (!back.ok) throw new Error(back.error)
          await saveTask(ctx, back.task)
          return { content: `收到修正${verdict.note ? `：${verdict.note}` : ""}。改完重新提交${stage === "analysis" ? "理解稿" : "清单"}。` }
        }

        const next = transition(task, stage === "analysis" ? "planning" : "executing")
        if (!next.ok) throw new Error(next.error)
        const confirmed: Task = stage === "plan" ? { ...next.task, leasePlanVersion: next.task.planVersion } : next.task
        await saveTask(ctx, confirmed)
        log(`${stage} 确认 ${task.id}`)
        return {
          content:
            stage === "analysis"
              ? `已确认第 ${task.analysisVersion} 稿。接下来提交任务清单。`
              : `已确认第 ${task.planVersion} 版清单，开始执行。`,
        }
      },
    })
  })
}
