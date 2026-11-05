import { describe, expect, test } from "bun:test"
import {
  clearEvidence,
  compareSnapshots,
  crossCheckTests,
  entryFromEvent,
  readEvidence,
  recordToolEvent,
  snapshotVcs,
  type EvidenceEntry,
} from "../src/evidence.ts"

function fakeCtx() {
  const map = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => void map.set(key, value),
      remove: async (key: string) => void map.delete(key),
    },
    vcs: {
      status: async () => [
        { file: "a.ts", additions: 3, deletions: 1, status: "modified" as const },
      ],
      diff: async () => [{ file: "a.ts", patch: "@@ -1 +1 @@" }],
    },
  }
}

describe("工具调用转证据", () => {
  test("成功调用记录工具与目标", () => {
    const entry = entryFromEvent({ tool: "edit", input: { filePath: "a.ts" }, status: "completed" }, 100)
    expect(entry).toEqual({ at: 100, tool: "edit", ok: true, target: "a.ts" })
  })

  test("失败调用记录错误", () => {
    const entry = entryFromEvent(
      { tool: "shell", input: { command: "bun test" }, status: "error", error: { message: "1 fail" } },
      200,
    )
    expect(entry.ok).toBe(false)
    expect(entry.command).toBe("bun test")
    expect(entry.error).toBe("1 fail")
  })

  test("shell 调用保留完整命令", () => {
    const entry = entryFromEvent({ tool: "shell", input: { command: "bun test test/state.test.ts" }, status: "completed" })
    expect(entry.command).toBe("bun test test/state.test.ts")
  })
})

describe("证据存取", () => {
  test("按会话追加并在清除后消失", async () => {
    const ctx = fakeCtx()
    await recordToolEvent(ctx, "s1", { tool: "read", input: { path: "a.ts" }, status: "completed" }, 1)
    await recordToolEvent(ctx, "s1", { tool: "edit", input: { filePath: "a.ts" }, status: "completed" }, 2)
    expect((await readEvidence(ctx, "s1")).length).toBe(2)
    await clearEvidence(ctx, "s1")
    expect(await readEvidence(ctx, "s1")).toEqual([])
  })

  test("不同会话证据隔离", async () => {
    const ctx = fakeCtx()
    await recordToolEvent(ctx, "s1", { tool: "read", input: {}, status: "completed" })
    expect(await readEvidence(ctx, "s2")).toEqual([])
  })

  test("没有会话 ID 时不写入", async () => {
    const ctx = fakeCtx()
    await recordToolEvent(ctx, "", { tool: "read", input: {}, status: "completed" })
    expect(await readEvidence(ctx, "")).toEqual([])
  })
})

describe("VCS 快照", () => {
  test("读取状态与 diff", async () => {
    const snapshot = await snapshotVcs(fakeCtx())
    expect(snapshot.files).toEqual([{ file: "a.ts", additions: 3, deletions: 1, status: "modified" }])
    expect(snapshot.diff).toContain("a.ts")
  })

  test("对比起止只保留变化文件", () => {
    const before = { files: [{ file: "a.ts", additions: 1, deletions: 0, status: "modified" as const }], diff: "" }
    const after = {
      files: [
        { file: "a.ts", additions: 2, deletions: 0, status: "modified" as const },
        { file: "b.ts", additions: 5, deletions: 0, status: "added" as const },
      ],
      diff: "",
    }
    const changed = compareSnapshots(before, after)
    expect(changed.map((item) => item.file)).toEqual(["a.ts", "b.ts"])
  })
})

describe("测试声明核对", () => {
  const evidence: EvidenceEntry[] = [
    { at: 1, tool: "shell", ok: true, target: "bun test", command: "bun test test/state.test.ts" },
    { at: 2, tool: "shell", ok: false, target: "bun test", command: "bun test test/broken.test.ts" },
  ]

  test("有成功记录的命令算已验证", () => {
    const result = crossCheckTests(["bun test test/state.test.ts"], evidence)
    expect(result.verified).toEqual(["bun test test/state.test.ts"])
    expect(result.unverified).toEqual([])
  })

  test("只有失败记录的命令算未验证", () => {
    const result = crossCheckTests(["bun test test/broken.test.ts"], evidence)
    expect(result.verified).toEqual([])
    expect(result.unverified).toEqual(["bun test test/broken.test.ts"])
  })

  test("没有记录的命令算未验证", () => {
    const result = crossCheckTests(["bun run build"], evidence)
    expect(result.unverified).toEqual(["bun run build"])
  })
})
