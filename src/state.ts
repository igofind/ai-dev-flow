// 任务状态：六个状态、合法迁移、ctx.storage 读写。
// 纯逻辑与最小 IO 放在一起；稿件内容不在这里，只存路径。

export type TaskState =
  | "analyzing"
  | "awaiting_analysis"
  | "planning"
  | "awaiting_plan"
  | "executing"
  | "closed"

export type ItemStatus = "pending" | "doing" | "done" | "blocked"

export type DraftRef = {
  kind: "analysis" | "plan"
  version: number
  path: string
  createdAt: number
}

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

export type Completion = {
  summary: string
  changedFiles: string[]
  tests: string[]
  unfinished: string[]
  at: number
}

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

const ALLOWED: Record<TaskState, TaskState[]> = {
  analyzing: ["awaiting_analysis", "closed"],
  awaiting_analysis: ["analyzing", "planning", "closed"],
  planning: ["awaiting_plan", "closed"],
  awaiting_plan: ["planning", "executing", "closed"],
  executing: ["closed"],
  closed: [],
}

export type TransitionResult = { ok: true; task: Task } | { ok: false; error: string }

export function transition(task: Task, next: TaskState, now = Date.now()): TransitionResult {
  if (!ALLOWED[task.state].includes(next))
    return { ok: false, error: `不能从 ${task.state} 转到 ${next}。` }
  return { ok: true, task: { ...task, state: next, updatedAt: now } }
}

export function isOpen(task: Task | undefined): boolean {
  return !!task && task.state !== "closed"
}

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

export function newTaskID(now = Date.now()): string {
  return `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const PREFIX = "ai-dev-flow"
const taskKey = (sessionID: string) => `${PREFIX}/task/${sessionID}`

export async function loadTask(ctx: any, sessionID: string): Promise<Task | undefined> {
  const value = await ctx.storage.get(taskKey(sessionID))
  if (!value || typeof value !== "object") return undefined
  if ((value as Task).sessionID !== sessionID) return undefined
  return value as Task
}

export async function saveTask(ctx: any, task: Task): Promise<void> {
  await ctx.storage.set(taskKey(task.sessionID), task)
}

export async function clearTask(ctx: any, sessionID: string): Promise<void> {
  await ctx.storage.remove(taskKey(sessionID))
}
