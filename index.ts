// 插件入口：注册工具、证据钩子和上下文规则。
// 状态在 ctx.storage，稿件写在工作目录的 .ai-dev-flow/tasks/<id>/ 下。

import fs from "node:fs"
import path from "node:path"

import { analysisCard, classifyAnswer, createCardWaiter, createCards, planCard, readService } from "./src/cards.ts"
import { crossCheckTests, readEvidence, recordToolEvent } from "./src/evidence.ts"
import { RULES_TEXT, statusLine } from "./src/rules.ts"
import { createTask, loadTask, newTaskID, saveTask, transition, type Task } from "./src/state.ts"
import {
  applyFinish,
  applyProgress,
  applySubmitAnalysis,
  applySubmitPlan,
  draftFileName,
  missingAnalysisFields,
  normalizePlan,
  registerTools,
  renderPlanMaterial,
} from "./src/tools.ts"

function log(message: string): void {
  try {
    fs.appendFileSync(path.join(process.env.TMPDIR ?? "/tmp", "ai-dev-flow.log"), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

export default {
  id: "ai-dev-flow",

  async setup(ctx: any) {
    const service = readService()
    const cards = createCards(service)
    const waiter = createCardWaiter()
    const controller = new AbortController()
    const rootCache = new Map<string, string>()

    log(`setup 服务=${service ? service.url : "读不到 service.json"}`)

    async function rootOf(sessionID: string): Promise<string | undefined> {
      const cached = rootCache.get(sessionID)
      if (cached) return cached
      let current = sessionID
      try {
        for (let depth = 0; depth < 10; depth++) {
          const info = await ctx.session.get({ sessionID: current })
          if (!info) return undefined
          if (!info.parentID) {
            rootCache.set(sessionID, current)
            return current
          }
          current = info.parentID
        }
      } catch (error) {
        log(`向上找父会话失败: ${String(error).slice(0, 120)}`)
      }
      return undefined
    }

    async function workdirOf(sessionID: string): Promise<string | undefined> {
      try {
        const info = await ctx.session.get({ sessionID })
        const directory = info?.location?.directory ?? info?.directory ?? info?.path
        if (typeof directory === "string" && path.isAbsolute(directory)) return directory
      } catch (error) {
        log(`读取会话工作目录失败: ${String(error).slice(0, 120)}`)
      }
      return undefined
    }

    async function requireRoot(context: any): Promise<string> {
      const sessionID = String(context?.sessionID ?? "")
      if (!sessionID) throw new Error("拿不到会话 ID。")
      const root = await rootOf(sessionID)
      if (!root) throw new Error("无法确认主会话。")
      if (root !== sessionID) throw new Error("只允许主会话调用流程工具。")
      return root
    }

    function taskDir(workdir: string, taskID: string): string {
      return path.join(workdir, ".ai-dev-flow", "tasks", taskID)
    }

    function writeDraft(dir: string, fileName: string, content: string): string {
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, fileName)
      fs.writeFileSync(filePath, content)
      return filePath
    }

    const handlers = {
      async submitAnalysis(input: any, context: any) {
        const root = await requireRoot(context)
        const summary = String(input?.summary ?? "").trim()
        if (!summary) throw new Error("summary 不能为空。")
        if (summary.length > 160) throw new Error(`summary 太长（${summary.length} 字），压到 160 字以内。`)
        const material = String(input?.material ?? "")
        if (!material.trim()) throw new Error("material 不能为空。")
        const missing = missingAnalysisFields(material)
        if (missing.length > 0) throw new Error(`理解稿缺字段：${missing.join("、")}。`)

        const workdir = await workdirOf(root)
        if (!workdir) throw new Error("读不到会话工作目录。")

        const existing = await loadTask(ctx, root)
        const task =
          existing && existing.state !== "closed"
            ? existing
            : createTask({
                id: newTaskID(),
                sessionID: root,
                title: String(input?.task ?? "").trim() || "未命名任务",
                workdir,
                dir: "",
              })
        const dir = taskDir(workdir, task.id)
        const version = task.analysisVersion + 1
        const filePath = writeDraft(
          dir,
          draftFileName(task.id, "analysis", version),
          `# ${task.title}\n\n任务 ${task.id} · 理解与分析第 ${version} 稿\n\n${material}\n`,
        )
        const result = applySubmitAnalysis({ ...task, dir }, { path: filePath, version })
        if (!result.ok) throw new Error(result.error)
        await saveTask(ctx, result.task)
        log(`理解稿 ${task.id} 第 ${version} 稿`)
        return { content: `第 ${version} 稿已生成（任务 ${task.id}）：${filePath}\n先贴链接再调用 flow_confirm。` }
      },

      async submitPlan(input: any, context: any) {
        const root = await requireRoot(context)
        const task = await loadTask(ctx, root)
        if (!task) throw new Error("没有任务：先提交理解与分析。")
        const normalized = normalizePlan(input, task.workdir)
        if (!normalized.ok) throw new Error(normalized.error)

        const version = task.planVersion + 1
        const material = renderPlanMaterial(normalized.plan.items, normalized.plan.scripts, String(input?.summary ?? ""))
        const filePath = writeDraft(
          task.dir,
          draftFileName(task.id, "plan", version),
          `# ${task.title}\n\n任务 ${task.id} · 任务清单第 ${version} 版\n\n${material}\n`,
        )
        const result = applySubmitPlan(task, { path: filePath, version, plan: normalized.plan })
        if (!result.ok) throw new Error(result.error)
        await saveTask(ctx, result.task)
        log(`清单 ${task.id} 第 ${version} 版`)
        return { content: `第 ${version} 版清单已生成（任务 ${task.id}）：${filePath}\n先贴链接再调用 flow_confirm。` }
      },

      async progress(input: any, context: any) {
        const root = await requireRoot(context)
        const task = await loadTask(ctx, root)
        if (!task) throw new Error("没有任务。")
        const result = applyProgress(task, {
          itemID: input?.itemID ? String(input.itemID) : undefined,
          status: input?.status,
          blockedOn: input?.blockedOn,
          note: input?.note ? String(input.note) : undefined,
        })
        if (!result.ok) throw new Error(result.error)
        await saveTask(ctx, result.task)
        const open = result.task.items.filter((item) => item.status !== "done")
        return {
          content: `进度已更新。未完成 ${open.length} 项${open[0] ? `，下一项 ${open[0].id} ${open[0].title}` : ""}。`,
        }
      },

      async finish(input: any, context: any) {
        const root = await requireRoot(context)
        const task = await loadTask(ctx, root)
        if (!task) throw new Error("没有任务。")
        const evidence = await readEvidence(ctx, root)
        const tests = Array.isArray(input?.tests) ? input.tests.map((item: any) => String(item)) : []
        const check = crossCheckTests(tests, evidence)
        const result = applyFinish(task, {
          summary: String(input?.summary ?? ""),
          changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.map((item: any) => String(item)) : [],
          tests,
          unfinished: Array.isArray(input?.unfinished) ? input.unfinished.map((item: any) => String(item)) : [],
        })
        if (!result.ok) throw new Error(result.error)
        await saveTask(ctx, result.task)
        log(`任务结束 ${task.id} 已验证 ${check.verified.length} 未验证 ${check.unverified.length}`)
        const warning =
          check.unverified.length > 0 ? `\n未找到对应命令记录的测试：${check.unverified.join("、")}；交付说明里要标为未验证。` : ""
        return { content: `任务 ${task.id} 已结束。测试 ${check.verified.length} 项有记录${warning}` }
      },
    }

    await registerTools(ctx, handlers)

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
          const root = await requireRoot(context)
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

    await ctx.tool.hook("execute.after", (event: any) => {
      const sessionID = String(event?.sessionID ?? "")
      if (!sessionID) return
      void (async () => {
        try {
          const root = (await rootOf(sessionID)) ?? sessionID
          await recordToolEvent(ctx, root, event)
        } catch (error) {
          log(`记录证据失败: ${String(error).slice(0, 120)}`)
        }
      })()
    })

    await ctx.session.hook("context", async (event: any) => {
      const sessionID = String(event?.sessionID ?? "")
      if (!sessionID) return
      const root = (await rootOf(sessionID)) ?? sessionID
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
