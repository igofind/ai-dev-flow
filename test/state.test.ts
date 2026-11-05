import { describe, expect, test } from "bun:test"
import { clearTask, createTask, isOpen, loadTask, newTaskID, saveTask, transition } from "../src/state.ts"

function fakeCtx() {
  const map = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => void map.set(key, value),
      remove: async (key: string) => void map.delete(key),
    },
    map,
  }
}

function baseTask() {
  return createTask({
    id: "t1",
    sessionID: "s1",
    title: "测试任务",
    workdir: "/tmp/project",
    dir: "/tmp/project/.ai-dev-flow/t1",
    now: 1000,
  })
}

describe("六态状态机", () => {
  test("新建任务从 analyzing 开始", () => {
    expect(baseTask().state).toBe("analyzing")
  })

  test("主路径逐级迁移到 closed", () => {
    let task = baseTask()
    for (const next of ["awaiting_analysis", "planning", "awaiting_plan", "executing", "closed"] as const) {
      const result = transition(task, next, 2000)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      task = result.task
    }
    expect(task.state).toBe("closed")
    expect(task.updatedAt).toBe(2000)
  })

  test("待确认理解可以退回 analyzing 修正", () => {
    const first = transition(baseTask(), "awaiting_analysis")
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const back = transition(first.task, "analyzing")
    expect(back.ok).toBe(true)
  })

  test("待确认清单可以退回 planning 修正", () => {
    const first = transition(baseTask(), "awaiting_analysis")
    if (!first.ok) return
    const second = transition(first.task, "planning")
    if (!second.ok) return
    const third = transition(second.task, "awaiting_plan")
    if (!third.ok) return
    const back = transition(third.task, "planning")
    expect(back.ok).toBe(true)
  })

  test("任意进行中状态可以取消到 closed", () => {
    const closed = transition(baseTask(), "closed")
    expect(closed.ok).toBe(true)
  })

  test("拒绝跳过确认直接执行", () => {
    const result = transition(baseTask(), "executing")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("analyzing")
  })

  test("closed 不能再迁移", () => {
    const closed = transition(baseTask(), "closed")
    if (!closed.ok) return
    expect(transition(closed.task, "executing").ok).toBe(false)
  })

  test("isOpen 只对未结束任务为真", () => {
    expect(isOpen(baseTask())).toBe(true)
    expect(isOpen(undefined)).toBe(false)
  })
})

describe("storage 会话指针", () => {
  test("保存后可读回", async () => {
    const ctx = fakeCtx()
    const task = baseTask()
    await saveTask(ctx, task)
    expect(await loadTask(ctx, "s1")).toEqual(task)
  })

  test("不同会话互相隔离", async () => {
    const ctx = fakeCtx()
    await saveTask(ctx, baseTask())
    expect(await loadTask(ctx, "s2")).toBeUndefined()
  })

  test("清除后读不到", async () => {
    const ctx = fakeCtx()
    await saveTask(ctx, baseTask())
    await clearTask(ctx, "s1")
    expect(await loadTask(ctx, "s1")).toBeUndefined()
  })

  test("任务 ID 不重复", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTaskID()))
    expect(ids.size).toBe(20)
  })
})
