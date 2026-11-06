// 插件入口：装配会话、卡片、工具和钩子。
// 状态在 ctx.storage，稿件写在工作目录的 .ai-dev-flow/tasks/<id>/ 下。

import fs from "node:fs"
import path from "node:path"

import { createCards, createCardWaiter, readService } from "./src/cards.ts"
import { registerConfirm } from "./src/confirm.ts"
import { recordToolEvent } from "./src/evidence.ts"
import { createHandlers } from "./src/handlers.ts"
import { RULES_TEXT, statusLine } from "./src/rules.ts"
import { createSessionResolver } from "./src/session.ts"
import { loadTask } from "./src/state.ts"
import { registerTools } from "./src/tools.ts"

// 把一行日志追加到临时目录的 ai-dev-flow.log；写失败时忽略。
function log(message: string): void {
  try {
    fs.appendFileSync(path.join(process.env.TMPDIR ?? "/tmp", "ai-dev-flow.log"), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

export default {
  id: "ai-dev-flow",

  // 插件入口：装配会话、卡片、工具和钩子，返回清理函数。
  async setup(ctx: any) {
    const service = readService()
    const cards = createCards(service)
    const waiter = createCardWaiter()
    const controller = new AbortController()
    const session = createSessionResolver(ctx, log)

    log(`setup 服务=${service ? service.url : "读不到 service.json"}`)

    const handlers = createHandlers({ ctx, session, log })
    await registerTools(ctx, handlers)
    await registerConfirm({ ctx, session, cards, waiter, log })

    await ctx.tool.hook("execute.after", (event: any) => {
      const sessionID = String(event?.sessionID ?? "")
      if (!sessionID) return
      void (async () => {
        try {
          const root = (await session.rootOf(sessionID)) ?? sessionID
          await recordToolEvent(ctx, root, event)
        } catch (error) {
          log(`记录证据失败: ${String(error).slice(0, 120)}`)
        }
      })()
    })

    await ctx.session.hook("context", async (event: any) => {
      const sessionID = String(event?.sessionID ?? "")
      if (!sessionID) return
      const root = (await session.rootOf(sessionID)) ?? sessionID
      const task = await loadTask(ctx, root)
      event.system.push({ type: "text", text: `${RULES_TEXT}\n\n${statusLine(task)}` })
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event?.type !== "form.replied" && event?.type !== "form.cancelled") continue
          const formID = event.data?.id
          if (!formID) continue
          const answer = event.type === "form.cancelled" ? { cancelled: true } : (event.data?.answer ?? {})
          waiter.settle(formID, answer)
        }
      } catch (error) {
        log(`事件订阅结束: ${String(error).slice(0, 160)}`)
      }
    })()

    log("闸门已就绪")
    return () => controller.abort()
  },
}
