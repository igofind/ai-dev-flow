// 任务状态：六个状态、合法迁移、ctx.storage 读写。
// 纯逻辑与最小 IO 放在一起；稿件内容不在这里，只存路径。

// 任务的六个状态。
export type TaskState =
  | "analyzing"
  | "awaiting_analysis"
  | "planning"
  | "awaiting_plan"
  | "executing"
  | "closed"

// 清单项的状态。
export type ItemStatus = "pending" | "doing" | "done" | "blocked"

// 稿件引用：类型、版本、路径和创建时间。
export type DraftRef = {
  kind: "analysis" | "plan"
  version: number
  path: string
  createdAt: number
}

// 清单项：动作、涉及文件、命令、脚本和完成标准。
export type PlanItem = {
  id: string
  title: string
  action: string
  files: string[]
  commands: string[]
  scripts: string[]
  doneCriteria: string
  dependsOn?: string
  status: ItemStatus
  note?: string
}

// 收尾记录：交付总结、改动文件、测试和未完成项。
export type Completion = {
  summary: string
  changedFiles: string[]
  tests: string[]
  unfinished: string[]
  at: number
}

// 任务状态快照，整体存在 ctx.storage。
export type Task = {
  id: string
  sessionID: string
  title: string
  state: TaskState
  workdir: string
  dir: string
  analysisVersion: number
  planVersion: number
  currentAnalysis?: DraftRef
  currentPlan?: DraftRef
  items: PlanItem[]
  scripts: string[]
  leasePlanVersion?: number
  blockedOn?: "boundary" | "unexpected-change" | "error"
  completion?: Completion
  createdAt: number
  updatedAt: number
}

// 每个状态允许迁移到的下一状态。
const ALLOWED: Record<TaskState, TaskState[]> = {
  analyzing: ["awaiting_analysis", "closed"],
  awaiting_analysis: ["analyzing", "planning", "closed"],
  planning: ["awaiting_plan", "closed"],
  awaiting_plan: ["planning", "executing", "closed"],
  executing: ["closed"],
  closed: [],
}

// 状态迁移结果：成功带新任务，失败带原因。
export type TransitionResult = { ok: true; task: Task } | { ok: false; error: string }

// 按允许表迁移任务状态。
export function transition(task: Task, next: TaskState, now = Date.now()): TransitionResult {
  if (!ALLOWED[task.state].includes(next))
    return { ok: false, error: `不能从 ${task.state} 转到 ${next}。` }
  return { ok: true, task: { ...task, state: next, updatedAt: now } }
}

// 判断任务是否还没结束。
export function isOpen(task: Task | undefined): boolean {
  return !!task && task.state !== "closed"
}

// 新建一个处于 analyzing 状态的任务。
export function createTask(input: {
  id: string
  sessionID: string
  title: string
  workdir: string
  dir: string
  now?: number
}): Task {
  const now = input.now ?? Date.now()
  return {
    id: input.id,
    sessionID: input.sessionID,
    title: input.title,
    state: "analyzing",
    workdir: input.workdir,
    dir: input.dir,
    analysisVersion: 0,
    planVersion: 0,
    items: [],
    scripts: [],
    createdAt: now,
    updatedAt: now,
  }
}

// 生成带时间戳和随机后缀的任务 ID。
export function newTaskID(now = Date.now()): string {
  return `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// storage key 的前缀。
const PREFIX = "ai-dev-flow"

// 按会话生成任务的 storage key。
const taskKey = (sessionID: string) => `${PREFIX}/task/${sessionID}`

// 按会话读取任务；读不到或会话不匹配时返回 undefined。
export async function loadTask(ctx: any, sessionID: string): Promise<Task | undefined> {
  const value = await ctx.storage.get(taskKey(sessionID))
  if (!value || typeof value !== "object") return undefined
  if ((value as Task).sessionID !== sessionID) return undefined
  return value as Task
}

// 按会话保存任务。
export async function saveTask(ctx: any, task: Task): Promise<void> {
  await ctx.storage.set(taskKey(task.sessionID), task)
}

// 删除会话的任务记录。
export async function clearTask(ctx: any, sessionID: string): Promise<void> {
  await ctx.storage.remove(taskKey(sessionID))
}
