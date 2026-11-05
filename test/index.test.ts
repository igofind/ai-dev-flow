import { describe, expect, test } from "bun:test"
import plugin from "../index.ts"

function fakeCtx() {
  const map = new Map<string, unknown>()
  const tools: any[] = []
  const toolHooks: string[] = []
  const sessionHooks: string[] = []
  const callbacks: Record<string, any> = {}

  const ctx = {
    storage: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => void map.set(key, value),
      remove: async (key: string) => void map.delete(key),
    },
    tool: {
      transform: async (callback: any) =>
        callback({
          namespace: () => {},
          add: (tool: any) => tools.push(tool),
        }),
      hook: async (name: string, callback: any) => {
        toolHooks.push(name)
        callbacks[`tool:${name}`] = callback
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: undefined,
        location: { directory: "/tmp/project" },
      }),
      hook: async (name: string, callback: any) => {
        sessionHooks.push(name)
        callbacks[`session:${name}`] = callback
      },
    },
    event: {
      subscribe: async function* () {},
    },
  }

  return { ctx, tools, toolHooks, sessionHooks, callbacks }
}

describe("插件入口", () => {
  test("导出 id 与 setup", () => {
    expect(plugin.id).toBe("ai-dev-flow")
    expect(typeof plugin.setup).toBe("function")
  })

  test("注册五个工具和两个钩子", async () => {
    const { ctx, tools, toolHooks, sessionHooks } = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    expect(tools.map((tool) => tool.name)).toEqual([
      "submit_analysis",
      "submit_plan",
      "progress",
      "finish",
      "confirm",
    ])
    expect(toolHooks).toEqual(["execute.after"])
    expect(sessionHooks).toEqual(["context"])
    expect(typeof cleanup).toBe("function")
    cleanup()
  })

  test("context 钩子注入规则与状态", async () => {
    const { ctx, callbacks } = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    const event: any = { sessionID: "s1", system: [] }
    await callbacks["session:context"](event)
    expect(event.system[0].text).toContain("ai-dev-flow")
    expect(event.system[0].text).toContain("当前没有任务")
    cleanup()
  })

})
