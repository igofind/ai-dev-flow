import { describe, expect, test } from "bun:test"
import {
  analysisCard,
  classifyAnswer,
  createCardWaiter,
  createCards,
  planCard,
  type CardSpec,
} from "../src/cards.ts"
import { createTask } from "../src/state.ts"

function baseTask() {
  return createTask({
    id: "t1",
    sessionID: "s1",
    title: "重建 ai-dev-flow",
    workdir: "/tmp/project",
    dir: "/tmp/project/.ai-dev-flow/t1",
    now: 1000,
  })
}

describe("答复分类", () => {
  test("yes 是确认", () => {
    expect(classifyAnswer("yes")).toEqual({ kind: "confirm", note: "" })
  })

  test("cancel 是取消", () => {
    expect(classifyAnswer("cancel")).toEqual({ kind: "cancel", note: "" })
  })

  test("空答复无效", () => {
    expect(classifyAnswer("  ")).toEqual({ kind: "invalid", note: "" })
  })

  test("其他文字按修正处理并保留备注", () => {
    expect(classifyAnswer("清单漏了测试项")).toEqual({ kind: "revise", note: "清单漏了测试项" })
  })
})

describe("两张卡的内容", () => {
  test("理解稿卡带版本和任务号", () => {
    const card = analysisCard(baseTask())
    expect(card.title).toContain("第 0 稿")
    expect(card.question).toContain("t1")
    expect(card.options.map((option) => option.value)).toEqual(["yes", "cancel"])
  })

  test("清单卡带项数、文件数和脚本数", () => {
    const task = baseTask()
    task.items = [
      {
        id: "I1",
        title: "改 a",
        action: "写",
        files: ["a.ts"],
        commands: [],
        scripts: [],
        doneCriteria: "通过",
        status: "pending",
      },
      {
        id: "I2",
        title: "改 b",
        action: "写",
        files: ["a.ts", "b.ts"],
        commands: [],
        scripts: [],
        doneCriteria: "通过",
        status: "pending",
      },
    ]
    task.scripts = ["run.sh"]
    const card = planCard(task)
    expect(card.description).toContain("2 项")
    expect(card.description).toContain("文件 2 个")
    expect(card.description).toContain("脚本 1 个")
  })
})

describe("建卡与撤卡", () => {
  const spec: CardSpec = {
    title: "标题",
    question: "问题",
    description: "描述",
    options: [{ value: "yes", label: "确认", description: "" }],
  }

  test("没有服务时建卡返回 undefined", async () => {
    const cards = createCards(undefined)
    expect(await cards.create({ sessionID: "s1", ...spec })).toBeUndefined()
  })

  test("建卡请求字段正确", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ data: { id: "f1" } }), { status: 200 })
    }
    const cards = createCards({ url: "http://localhost:1", auth: "Basic x" }, fetcher)
    const id = await cards.create({ sessionID: "s1", ...spec })
    expect(id).toBe("f1")
    expect(calls[0].url).toBe("http://localhost:1/api/session/s1/form")
    expect(calls[0].init?.method).toBe("POST")
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.title).toBe("标题")
    expect(body.metadata.aiDevFlow).toBe(true)
    expect(body.fields[0].key).toBe("confirm")
    expect(body.fields[0].options[0].value).toBe("yes")
  })

  test("撤卡调用 DELETE", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response("{}", { status: 200 })
    }
    const cards = createCards({ url: "http://localhost:1", auth: "Basic x" }, fetcher)
    await cards.cancel("s1", "f1")
    expect(calls[0].url).toBe("http://localhost:1/api/session/s1/form/f1")
    expect(calls[0].init?.method).toBe("DELETE")
  })

  test("服务报错时不抛异常", async () => {
    const fetcher = async () => new Response("not json", { status: 500 })
    const cards = createCards({ url: "http://localhost:1", auth: "Basic x" }, fetcher)
    expect(await cards.create({ sessionID: "s1", ...spec })).toBeUndefined()
  })
})

describe("答复等待器", () => {
  test("先等待后答复", async () => {
    const waiter = createCardWaiter()
    const pending = waiter.wait("f1")
    waiter.settle("f1", { confirm: "yes" })
    expect(await pending).toEqual({ confirm: "yes" })
  })

  test("答复比等待先到也能取到", async () => {
    const waiter = createCardWaiter()
    waiter.settle("f1", { confirm: "cancel" })
    expect(await waiter.wait("f1")).toEqual({ confirm: "cancel" })
  })

  test("同一张卡重复答复只处理一次", () => {
    const waiter = createCardWaiter()
    expect(waiter.settle("f1", { confirm: "yes" })).toBe(true)
    expect(waiter.settle("f1", { confirm: "cancel" })).toBe(false)
  })
})
