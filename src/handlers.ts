// 四个流程工具的处理函数：校验、写稿、保存任务。

import {
  applyFinish,
  applyProgress,
  applySubmitAnalysis,
  applySubmitPlan,
  draftFileName,
  missingAnalysisFields,
  normalizePlan,
  renderPlanMaterial,
  type ToolHandlers,
} from "./tools.ts"
import { createTask, loadTask, newTaskID, saveTask } from "./state.ts"
import { crossCheckTests, readEvidence } from "./evidence.ts"
import { taskDir, writeDraft } from "./drafts.ts"

type Deps = {
  ctx: any
  session: {
    requireRoot: (context: any) => Promise<string>
    workdirOf: (sessionID: string) => Promise<string | undefined>
  }
  log: (message: string) => void
}

// 创建四个流程工具的处理函数。
export function createHandlers({ ctx, session, log }: Deps): ToolHandlers {
  return {
    // 处理理解稿提交：校验六字段，写稿并保存任务。
    async submitAnalysis(input: any, context: any) {
      const root = await session.requireRoot(context)
      const summary = String(input?.summary ?? "").trim()
      if (!summary) throw new Error("summary 不能为空。")
      if (summary.length > 160) throw new Error(`summary 太长（${summary.length} 字），压到 160 字以内。`)
      const material = String(input?.material ?? "")
      if (!material.trim()) throw new Error("material 不能为空。")
      const missing = missingAnalysisFields(material)
      if (missing.length > 0) throw new Error(`理解稿缺字段：${missing.join("、")}。`)

      const workdir = await session.workdirOf(root)
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

    // 处理清单提交：校验清单，写稿并保存任务。
    async submitPlan(input: any, context: any) {
      const root = await session.requireRoot(context)
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

    // 处理进度更新：改清单项状态或阻塞原因。
    async progress(input: any, context: any) {
      const root = await session.requireRoot(context)
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

    // 处理收尾：核对测试证据，写交付总结并关闭任务。
    async finish(input: any, context: any) {
      const root = await session.requireRoot(context)
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
}
