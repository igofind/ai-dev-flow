// 两张确认卡：建卡、撤卡、答复分类。
// 走本机服务的表单接口；换接口只改这一层。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Task } from "./state.ts"

// 卡片服务的地址与鉴权。
export type CardService = { url: string; auth: string }

// 卡片的一个可选项。
export type CardOption = { value: string; label: string; description: string }

// 一张卡片的规格：标题、问题、说明和选项。
export type CardSpec = {
  title: string
  question: string
  description: string
  options: CardOption[]
}

// 卡片答复的分类和备注。
export type Answer = { kind: "confirm" | "cancel" | "revise" | "invalid"; note: string }

// 确认卡的两个选项：确认和取消任务。
export const CONFIRM_OPTIONS: CardOption[] = [
  { value: "yes", label: "确认", description: "按这一稿继续" },
  { value: "cancel", label: "取消任务", description: "结束任务，不留授权" },
]

// 截断文本，超出长度时加省略号。
function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

// 把卡片原始答复分类成确认、取消、修正或无效。
export function classifyAnswer(raw: string): Answer {
  const value = raw.trim()
  if (!value) return { kind: "invalid", note: "" }
  if (value === "yes") return { kind: "confirm", note: "" }
  if (value === "cancel") return { kind: "cancel", note: "" }
  return { kind: "revise", note: value }
}

// 生成理解稿的确认卡。
export function analysisCard(task: Task): CardSpec {
  const version = task.currentAnalysis?.version ?? task.analysisVersion
  return {
    title: `理解与分析 · 第 ${version} 稿`,
    question: `任务：${clip(task.title, 40)}（${task.id}）`,
    description: `第 ${version} 稿｜${clip(task.title, 24)}｜确认后继续写任务清单｜输入文字即修正`,
    options: CONFIRM_OPTIONS,
  }
}

// 生成任务清单的确认卡。
export function planCard(task: Task): CardSpec {
  const version = task.currentPlan?.version ?? task.planVersion
  const files = new Set(task.items.flatMap((item) => item.files))
  return {
    title: `任务清单 · 第 ${version} 版`,
    question: `任务：${clip(task.title, 40)}（${task.id}）`,
    description: `第 ${version} 版｜${task.items.length} 项 / 文件 ${files.size} 个 / 脚本 ${task.scripts.length} 个｜确认后开始执行｜输入文字即修正`,
    options: CONFIRM_OPTIONS,
  }
}

/** 从本机服务配置读取地址与鉴权；读不到返回 undefined */
export function readService(): CardService | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/opencode/service.json"), "utf8"))
    const auth = `Basic ${Buffer.from(`opencode:${config.password ?? "opencode"}`).toString("base64")}`
    return { url: `http://${config.hostname}:${config.port}`, auth }
  } catch {
    return undefined
  }
}

// 请求函数签名。
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

// 创建卡片服务客户端，提供建卡和撤卡。
export function createCards(service: CardService | undefined, fetcher: Fetcher = fetch) {
  // 创建一张卡片并返回卡片 ID。
  async function create(input: CardSpec & { sessionID: string }): Promise<string | undefined> {
    if (!service) return undefined
    try {
      const response = await fetcher(`${service.url}/api/session/${input.sessionID}/form`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: service.auth },
        body: JSON.stringify({
          title: input.title,
          metadata: { kind: "question", aiDevFlow: true },
          fields: [
            {
              key: "confirm",
              type: "string",
              title: input.question,
              description: input.description,
              options: input.options,
              custom: true,
            },
          ],
        }),
      })
      const body: any = await response.json().catch(() => ({}))
      return body?.data?.id
    } catch {
      return undefined
    }
  }

  // 撤回一张还没答复的卡片。
  async function cancel(sessionID: string, formID: string): Promise<void> {
    if (!service) return
    try {
      await fetcher(`${service.url}/api/session/${sessionID}/form/${formID}`, {
        method: "DELETE",
        headers: { authorization: service.auth },
      })
    } catch {
      // 撤卡失败不影响主流程
    }
  }

  return { create, cancel }
}

/** 卡片答复可能比等待先到，所以先存后取 */
export function createCardWaiter() {
  const waiters = new Map<string, (answer: any) => void>()
  const settled = new Map<string, any>()
  const handled = new Set<string>()

  // 等待某张卡片的答复。
  function wait(formID: string): Promise<any | undefined> {
    const done = settled.get(formID)
    if (done) {
      settled.delete(formID)
      return Promise.resolve(done)
    }
    return new Promise((resolve) => waiters.set(formID, resolve))
  }

  // 把答复交给等待者；如果还没人等，就先存起来。
  function settle(formID: string, answer: any): boolean {
    if (handled.has(formID)) return false
    handled.add(formID)
    const resolve = waiters.get(formID)
    if (resolve) {
      waiters.delete(formID)
      resolve(answer)
      return true
    }
    settled.set(formID, answer)
    return true
  }

  // 清空等待状态。
  function reset(): void {
    waiters.clear()
    settled.clear()
    handled.clear()
  }

  return { wait, settle, reset }
}
