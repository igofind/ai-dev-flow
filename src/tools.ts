// 四个流程工具：校验与状态迁移放纯函数，注册放 registerTools。

import path from "node:path"
import { transition, type Completion, type ItemStatus, type PlanItem, type Task } from "./state.ts"

export const ANALYSIS_FIELDS = ["要做什么", "依据", "方法", "边界", "不做什么", "待确认"] as const

export function missingAnalysisFields(material: string): string[] {
  return ANALYSIS_FIELDS.filter((label) => !new RegExp(`(^|\\n)\\s*[-*]?\\s*${label}\\s*[：:]`).test(material))
}

export function normalizeScript(raw: string): string | undefined {
  const value = String(raw ?? "").trim().replace(/^\.\/+/, "")
  if (!value) return undefined
  const withoutTmp = value.startsWith("tmp/") ? value.slice(4) : value
  if (!withoutTmp || withoutTmp.includes("/") || withoutTmp.includes("\\")) return undefined
  if (withoutTmp === "." || withoutTmp === "..") return undefined
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return undefined
  return withoutTmp
}

export function normalizeProjectFile(raw: string, workdir: string): string | undefined {
  const value = String(raw ?? "").trim()
  if (!value) return undefined
  const absolute = path.resolve(workdir, value)
  const root = path.resolve(workdir)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return undefined
  return path.relative(root, absolute)
}

export type NormalizedPlan = { items: Omit<PlanItem, "status">[]; scripts: string[] }

export function normalizePlan(input: any, workdir: string): { ok: true; plan: NormalizedPlan } | { ok: false; error: string } {
  const rawItems = Array.isArray(input?.items) ? input.items : []
  if (rawItems.length === 0) return { ok: false, error: "任务清单至少要有一项。" }

  const items: Omit<PlanItem, "status">[] = []
  const scripts = new Set<string>()

  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index] ?? {}
    const id = String(raw.id ?? `I${index + 1}`).trim() || `I${index + 1}`
    const title = String(raw.title ?? "").trim()
    const doneCriteria = String(raw.doneCriteria ?? "").trim()
    if (!title) return { ok: false, error: `第 ${index + 1} 项缺标题。` }
    if (!doneCriteria) return { ok: false, error: `第 ${index + 1} 项「${title}」缺完成标准。` }

    const files: string[] = []
    for (const file of Array.isArray(raw.files) ? raw.files : []) {
      const normalized = normalizeProjectFile(file, workdir)
      if (!normalized) return { ok: false, error: `第 ${index + 1} 项的文件不在会话目录内：${String(file)}` }
      files.push(normalized)
    }

    const itemScripts: string[] = []
    for (const script of Array.isArray(raw.scripts) ? raw.scripts : []) {
      const normalized = normalizeScript(script)
      if (!normalized) return { ok: false, error: `第 ${index + 1} 项的脚本必须放在 tmp/ 下且是纯文件名：${String(script)}` }
      itemScripts.push(normalized)
      scripts.add(normalized)
    }

    items.push({
      id,
      title,
      action: String(raw.action ?? title).trim(),
      files,
      commands: (Array.isArray(raw.commands) ? raw.commands : []).map((item: any) => String(item).trim()).filter(Boolean),
      scripts: itemScripts,
      doneCriteria,
      dependsOn: raw.dependsOn ? String(raw.dependsOn).trim() : undefined,
    })
  }

  for (const script of Array.isArray(input?.scripts) ? input.scripts : []) {
    const normalized = normalizeScript(script)
    if (!normalized) return { ok: false, error: `脚本必须放在 tmp/ 下且是纯文件名：${String(script)}` }
    scripts.add(normalized)
  }

  return { ok: true, plan: { items, scripts: [...scripts] } }
}

export function renderPlanMaterial(items: Omit<PlanItem, "status">[], scripts: string[], summary: string): string {
  const lines: string[] = []
  if (summary.trim()) lines.push(summary.trim(), "")
  for (const item of items) {
    lines.push(`### ${item.id} ${item.title}`, "")
    lines.push(`- 动作：${item.action}`)
    lines.push(`- 文件：${item.files.length > 0 ? item.files.map((file) => `\`${file}\``).join("、") : "无"}`)
    lines.push(`- 命令：${item.commands.length > 0 ? item.commands.map((command) => `\`${command}\``).join("、") : "无"}`)
    lines.push(`- 脚本：${item.scripts.length > 0 ? item.scripts.join("、") : "无"}`)
    lines.push(`- 完成标准：${item.doneCriteria}`)
    if (item.dependsOn) lines.push(`- 依赖：${item.dependsOn}`)
    lines.push("")
  }
  lines.push(`全部脚本：${scripts.length > 0 ? scripts.join("、") : "无"}`)
  return lines.join("\n")
}

export function draftFileName(taskID: string, kind: "analysis" | "plan", version: number): string {
  return `${taskID}-${kind}-v${version}.md`
}

export type ApplyResult = { ok: true; task: Task } | { ok: false; error: string }

export function applySubmitAnalysis(
  task: Task,
  input: { path: string; version: number; now?: number },
): ApplyResult {
  if (task.state !== "analyzing" && task.state !== "awaiting_analysis")
    return { ok: false, error: `任务当前是 ${task.state}，不能提交理解稿。` }
  const now = input.now ?? Date.now()
  return {
    ok: true,
    task: {
      ...task,
      state: "awaiting_analysis",
      analysisVersion: input.version,
      currentAnalysis: { kind: "analysis", version: input.version, path: input.path, createdAt: now },
      updatedAt: now,
    },
  }
}

export function applySubmitPlan(
  task: Task,
  input: { path: string; version: number; plan: NormalizedPlan; now?: number },
): ApplyResult {
  if (task.state !== "planning" && task.state !== "awaiting_plan")
    return { ok: false, error: `任务当前是 ${task.state}，不能提交任务清单。` }
  const now = input.now ?? Date.now()
  return {
    ok: true,
    task: {
      ...task,
      state: "awaiting_plan",
      planVersion: input.version,
      currentPlan: { kind: "plan", version: input.version, path: input.path, createdAt: now },
      items: input.plan.items.map((item) => ({ ...item, status: "pending" as ItemStatus })),
      scripts: input.plan.scripts,
      updatedAt: now,
    },
  }
}

export function applyProgress(
  task: Task,
  input: { itemID?: string; status?: ItemStatus; blockedOn?: Task["blockedOn"] | "none"; note?: string; now?: number },
): ApplyResult {
  if (task.state !== "executing") return { ok: false, error: `任务当前是 ${task.state}，不在执行中。` }
  const now = input.now ?? Date.now()
  const blockedOn = input.blockedOn === "none" ? undefined : input.blockedOn
  const itemID = input.itemID
  const status = input.status
  if (!itemID && !input.blockedOn) return { ok: false, error: "没有要更新的内容：给 itemID + status，或给 blockedOn。" }
  if (itemID && !status) return { ok: false, error: "更新清单项时要同时给 status。" }
  if (status && !itemID) return { ok: false, error: "给了 status 但没给 itemID。" }

  if (itemID && status) {
    if (!task.items.some((item) => item.id === itemID)) return { ok: false, error: `清单里没有 ${itemID}。` }
    return {
      ok: true,
      task: {
        ...task,
        items: task.items.map((item) =>
          item.id === itemID ? { ...item, status, note: input.note ?? item.note } : item,
        ),
        blockedOn: input.blockedOn === undefined ? task.blockedOn : blockedOn,
        updatedAt: now,
      },
    }
  }

  return { ok: true, task: { ...task, blockedOn, updatedAt: now } }
}

export function applyFinish(
  task: Task,
  input: { summary: string; changedFiles: string[]; tests: string[]; unfinished: string[]; now?: number },
): ApplyResult {
  if (task.state !== "executing") return { ok: false, error: `任务当前是 ${task.state}，不能收尾。` }
  const now = input.now ?? Date.now()
  const completion: Completion = {
    summary: input.summary,
    changedFiles: input.changedFiles,
    tests: input.tests,
    unfinished: input.unfinished,
    at: now,
  }
  const closed = transition(task, "closed", now)
  if (!closed.ok) return closed
  return { ok: true, task: { ...closed.task, completion } }
}

export type ToolHandlers = {
  submitAnalysis: (input: any, context: any) => Promise<{ content: string }>
  submitPlan: (input: any, context: any) => Promise<{ content: string }>
  progress: (input: any, context: any) => Promise<{ content: string }>
  finish: (input: any, context: any) => Promise<{ content: string }>
}

export async function registerTools(ctx: any, handlers: ToolHandlers): Promise<void> {
  await ctx.tool.transform((editor: any) => {
    editor.namespace({ name: "flow", description: "ai-dev-flow 的流程工具" })
    editor.add({
      name: "submit_analysis",
      description: "提交变更类任务的理解与分析：任务名、一句摘要、六个字段的正文。校验后写稿并返回绝对路径，不弹卡；先贴链接再调用 flow_confirm。",
      input: {
        type: "object",
        properties: {
          task: { type: "string", description: "任务名，一句话" },
          summary: { type: "string", description: "一两句人话，160 字以内" },
          material: {
            type: "string",
            description: "正文，六个字段各占一行：要做什么 / 依据 / 方法 / 边界 / 不做什么 / 待确认。查不到的标【未验证】",
          },
        },
        required: ["task", "summary", "material"],
        additionalProperties: false,
      },
      options: { namespace: "flow" },
      execute: handlers.submitAnalysis,
    })
    editor.add({
      name: "submit_plan",
      description: "提交任务清单：每项写清标题、动作、文件、命令、脚本、完成标准。校验后写稿并返回绝对路径，不弹卡；先贴链接再调用 flow_confirm。",
      input: {
        type: "object",
        properties: {
          summary: { type: "string", description: "一两句人话，160 字以内" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                action: { type: "string" },
                files: { type: "array", items: { type: "string" } },
                commands: { type: "array", items: { type: "string" } },
                scripts: { type: "array", items: { type: "string" } },
                doneCriteria: { type: "string" },
                dependsOn: { type: "string" },
              },
              required: ["title", "doneCriteria"],
              additionalProperties: false,
            },
          },
          scripts: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "items"],
        additionalProperties: false,
      },
      options: { namespace: "flow" },
      execute: handlers.submitPlan,
    })
    editor.add({
      name: "progress",
      description: "更新执行进度：给 itemID + status（pending / doing / done / blocked），或给 blockedOn（boundary / unexpected-change / error / none）。每完成一项标 done。",
      input: {
        type: "object",
        properties: {
          itemID: { type: "string", description: "清单项编号，如 I1" },
          status: { type: "string", enum: ["pending", "doing", "done", "blocked"] },
          blockedOn: { type: "string", enum: ["boundary", "unexpected-change", "error", "none"] },
          note: { type: "string", description: "可选说明，写进该项或日志" },
        },
        additionalProperties: false,
      },
      options: { namespace: "flow" },
      execute: handlers.progress,
    })
    editor.add({
      name: "finish",
      description: "任务完成后提交交付总结：改了什么、跑了什么验证、还有什么没做完。调用后任务结束，写权限失效。",
      input: {
        type: "object",
        properties: {
          summary: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
          tests: { type: "array", items: { type: "string" } },
          unfinished: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "changedFiles"],
        additionalProperties: false,
      },
      options: { namespace: "flow" },
      execute: handlers.finish,
    })
  })
}
