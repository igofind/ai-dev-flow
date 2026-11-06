// 证据：工具调用记录、VCS 起止快照、收尾时的测试声明核对。
// 证据只用于交付自审，不参与权限判断。

// 一条工具调用证据。
export type EvidenceEntry = {
  at: number
  tool: string
  ok: boolean
  target: string
  command?: string
  error?: string
}

// 一个变更文件的增删统计和状态。
export type VcsFile = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

// 一次工作区快照：变更文件列表和 diff 文本。
export type VcsSnapshot = {
  files: VcsFile[]
  diff: string
}

// storage key 的前缀。
const PREFIX = "ai-dev-flow"

// 按会话生成证据的 storage key。
const evidenceKey = (sessionID: string) => `${PREFIX}/evidence/${sessionID}`

// 把工具事件转成一条证据，记录工具名、成功与否、目标和命令。
export function entryFromEvent(event: any, now = Date.now()): EvidenceEntry {
  const tool = String(event?.tool ?? "")
  const input = event?.input ?? {}
  const ok = String(event?.status ?? "") !== "error"
  const target = String(input?.filePath ?? input?.path ?? input?.command ?? "")
  const entry: EvidenceEntry = {
    at: now,
    tool,
    ok,
    target: target.slice(0, 300),
  }
  if (tool === "shell") entry.command = String(input?.command ?? "").slice(0, 1000)
  if (!ok) entry.error = String(event?.error?.message ?? "").slice(0, 300)
  return entry
}

// 按会话读取证据列表。
export async function readEvidence(ctx: any, sessionID: string): Promise<EvidenceEntry[]> {
  const value = await ctx.storage.get(evidenceKey(sessionID))
  return Array.isArray(value) ? (value as EvidenceEntry[]) : []
}

// 按会话追加一条工具事件证据。
export async function recordToolEvent(ctx: any, sessionID: string, event: any, now = Date.now()): Promise<void> {
  if (!sessionID) return
  const entries = await readEvidence(ctx, sessionID)
  entries.push(entryFromEvent(event, now))
  await ctx.storage.set(evidenceKey(sessionID), entries)
}

// 清空会话的证据记录。
export async function clearEvidence(ctx: any, sessionID: string): Promise<void> {
  await ctx.storage.remove(evidenceKey(sessionID))
}

// 抓取当前工作区的 VCS 快照，包含文件状态和 diff。
export async function snapshotVcs(ctx: any): Promise<VcsSnapshot> {
  const files = (await ctx.vcs.status()) as VcsFile[]
  const diffs = (await ctx.vcs.diff({ mode: "working", context: 3 })) as { file: string; patch: string }[]
  return {
    files: files.map((item) => ({
      file: item.file,
      additions: item.additions,
      deletions: item.deletions,
      status: item.status,
    })),
    diff: diffs.map((item) => `--- ${item.file}\n${item.patch}`).join("\n"),
  }
}

// 比较两次快照，返回新增、删除或增删数有变化的文件。
export function compareSnapshots(before: VcsSnapshot, after: VcsSnapshot): VcsFile[] {
  const previous = new Map(before.files.map((item) => [item.file, item]))
  return after.files.filter((item) => {
    const old = previous.get(item.file)
    return !old || old.status !== item.status || old.additions !== item.additions || old.deletions !== item.deletions
  })
}

// 核对声明的测试命令是否有成功执行记录，返回已验证和未验证两组。
export function crossCheckTests(
  declared: string[],
  evidence: EvidenceEntry[],
): { verified: string[]; unverified: string[] } {
  const ran = evidence.filter((entry) => entry.tool === "shell" && entry.ok)
  const verified: string[] = []
  const unverified: string[] = []
  for (const command of declared) {
    const hit = ran.some((entry) => (entry.command ?? "").includes(command))
    if (hit) verified.push(command)
    else unverified.push(command)
  }
  return { verified, unverified }
}
