import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHandlers } from "../src/handlers.ts"
import { readEvidence, recordToolEvent } from "../src/evidence.ts"

function fakeCtx(workdir: string) {
  const map = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => void map.set(key, value),
      remove: async (key: string) => void map.delete(key),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: undefined,
        location: { directory: workdir },
      }),
    },
  }
}

describe("新建任务清空证据", () => {
  test("新任务创建后旧证据被清空", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-flow-test-"))
    try {
      const ctx = fakeCtx(workdir)
      const session = {
        requireRoot: async () => "s1",
        workdirOf: async () => workdir,
      }
      const handlers = createHandlers({ ctx, session, log: () => {} })

      await recordToolEvent(ctx, "s1", { tool: "shell", input: { command: "bun test" }, status: "completed" })

      await handlers.submitAnalysis(
        {
          task: "测试任务",
          summary: "摘要",
          material: "要做什么：A\n依据：B\n方法：C\n边界：D\n不做什么：E\n待确认：无",
        },
        { sessionID: "s1" },
      )

      expect(await readEvidence(ctx, "s1")).toEqual([])
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true })
    }
  })
})
