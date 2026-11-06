// 会话解析：从子会话找到主会话，读取工作目录。

import path from "node:path"

type Logger = (message: string) => void

// 创建会话解析器：rootOf、workdirOf、requireRoot。
export function createSessionResolver(ctx: any, log: Logger) {
  const rootCache = new Map<string, string>()

  // 沿 parentID 向上找到主会话；找不到返回 undefined。
  async function rootOf(sessionID: string): Promise<string | undefined> {
    const cached = rootCache.get(sessionID)
    if (cached) return cached
    let current = sessionID
    try {
      for (let depth = 0; depth < 10; depth++) {
        const info = await ctx.session.get({ sessionID: current })
        if (!info) return undefined
        if (!info.parentID) {
          rootCache.set(sessionID, current)
          return current
        }
        current = info.parentID
      }
    } catch (error) {
      log(`向上找父会话失败: ${String(error).slice(0, 120)}`)
    }
    return undefined
  }

  // 读取会话的工作目录；读不到返回 undefined。
  async function workdirOf(sessionID: string): Promise<string | undefined> {
    try {
      const info = await ctx.session.get({ sessionID })
      const directory = info?.location?.directory ?? info?.directory ?? info?.path
      if (typeof directory === "string" && path.isAbsolute(directory)) return directory
    } catch (error) {
      log(`读取会话工作目录失败: ${String(error).slice(0, 120)}`)
    }
    return undefined
  }

  // 确认当前是主会话并返回会话 ID，否则抛错。
  async function requireRoot(context: any): Promise<string> {
    const sessionID = String(context?.sessionID ?? "")
    if (!sessionID) throw new Error("拿不到会话 ID。")
    const root = await rootOf(sessionID)
    if (!root) throw new Error("无法确认主会话。")
    if (root !== sessionID) throw new Error("只允许主会话调用流程工具。")
    return root
  }

  return { rootOf, workdirOf, requireRoot }
}
