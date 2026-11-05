import { describe, expect, test } from "bun:test"
import {
  ANALYSIS_FIELDS,
  applyFinish,
  applyProgress,
  applySubmitAnalysis,
  applySubmitPlan,
  missingAnalysisFields,
  normalizePlan,
  normalizeScript,
  registerTools,
} from "../src/tools.ts"
import { createTask, transition, type Task } from "../src/state.ts"

function baseTask(state: Task["state"] = "analyzing"): Task {
  let task = createTask({
    id: "t1",
    sessionID: "s1",
    title: "测试",
    workdir: "/tmp/project",
    dir: "/tmp/project/.ai-dev-flow/t1",
    now: 1000,
  })
  for (const next of ["awaiting_analysis", "planning", "awaiting_plan", "executing"] as const) {
    if (task.state === state) break
    const result = transition(task, next)
    if (!result.ok) throw new Error(result.error)
    task = result.task
  }
  return task
}

describe("理解稿字段校验", () => {
  test("六个字段齐全时通过", () => {
    const material = ANALYSIS_FIELDS.map((field) => `${field}：内容`).join("\n")
    expect(missingAnalysisFields(material)).toEqual([])
  })

  test("缺字段时返回缺失项", () => {
    expect(missingAnalysisFields("要做什么：内容\n依据：内容")).toEqual(["方法", "边界", "不做什么", "待确认"])
  })
})

describe("脚本与清单校验", () => {
  test("脚本只接受 tmp/ 下纯文件名", () => {
    expect(normalizeScript("tmp/run.sh")).toBe("run.sh")
    expect(normalizeScript("run.sh")).toBe("run.sh")
    expect(normalizeScript("../run.sh")).toBeUndefined()
    expect(normalizeScript("a/b.sh")).toBeUndefined()
  })

  test("空清单拒绝", () => {
    const result = normalizePlan({ items: [] }, "/tmp/project")
    expect(result.ok).toBe(false)
  })

  test("缺完成标准拒绝", () => {
    const result = normalizePlan({ items: [{ title: "改 A" }] }, "/tmp/project")
    expect(result.ok).toBe(false)
  })

  test("文件逃出会话目录拒绝", () => {
    const result = normalizePlan({ items: [{ title: "改 A", doneCriteria: "通过", files: ["../x.ts"] }] }, "/tmp/project")
    expect(result.ok).toBe(false)
  })

  test("合法清单归一化路径并汇总脚本", () => {
    const result = normalizePlan(
      {
        items: [{ id: "I1", title: "改 A", doneCriteria: "通过", files: ["src/a.ts"], scripts: ["tmp/a.sh"] }],
        scripts: ["tmp/b.sh"],
      },
      "/tmp/project",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.items[0].files).toEqual(["src/a.ts"])
    expect(result.plan.scripts.sort()).toEqual(["a.sh", "b.sh"])
  })
})

describe("状态迁移", () => {
  test("提交理解稿进入待确认", () => {
    const result = applySubmitAnalysis(baseTask(), { path: "/tmp/a.md", version: 1, now: 2000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.state).toBe("awaiting_analysis")
    expect(result.task.currentAnalysis?.version).toBe(1)
  })

  test("已确认理解后再提交理解稿被拒", () => {
    const result = applySubmitAnalysis(baseTask("planning"), { path: "/tmp/a.md", version: 2 })
    expect(result.ok).toBe(false)
  })

  test("提交清单进入待确认并重置项状态", () => {
    const result = applySubmitPlan(baseTask("planning"), {
      path: "/tmp/p.md",
      version: 1,
      plan: {
        items: [{ id: "I1", title: "改 A", action: "写", files: [], commands: [], scripts: [], doneCriteria: "通过" }],
        scripts: [],
      },
      now: 3000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.state).toBe("awaiting_plan")
    expect(result.task.items[0].status).toBe("pending")
  })

  test("执行中更新项状态", () => {
    const task = baseTask("executing")
    task.items = [
      {
        id: "I1",
        title: "改 A",
        action: "写",
        files: [],
        commands: [],
        scripts: [],
        doneCriteria: "通过",
        status: "doing",
      },
    ]
    const result = applyProgress(task, { itemID: "I1", status: "done", now: 4000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.items[0].status).toBe("done")
    expect(result.task.updatedAt).toBe(4000)
  })

  test("非执行中更新被拒", () => {
    expect(applyProgress(baseTask("planning"), { itemID: "I1", status: "done" }).ok).toBe(false)
  })

  test("缺参数更新被拒", () => {
    expect(applyProgress(baseTask("executing"), {}).ok).toBe(false)
  })

  test("收尾关闭任务并记录总结", () => {
    const result = applyFinish(baseTask("executing"), {
      summary: "完成",
      changedFiles: ["a.ts"],
      tests: ["bun test"],
      unfinished: [],
      now: 5000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.state).toBe("closed")
    expect(result.task.completion?.summary).toBe("完成")
  })

  test("非执行中收尾被拒", () => {
    const result = applyFinish(baseTask("awaiting_plan"), { summary: "完成", changedFiles: [], tests: [], unfinished: [] })
    expect(result.ok).toBe(false)
  })
})

describe("工具注册", () => {
  test("注册四个工具到 flow 命名空间", async () => {
    const names: string[] = []
    const ctx = {
      tool: {
        transform: async (callback: any) =>
          callback({
            namespace: () => {},
            add: (tool: any) => names.push(tool.name),
          }),
      },
    }
    const handler = async () => ({ content: "ok" })
    await registerTools(ctx, {
      submitAnalysis: handler,
      submitPlan: handler,
      progress: handler,
      finish: handler,
    })
    expect(names).toEqual(["submit_analysis", "submit_plan", "progress", "finish"])
  })
})
