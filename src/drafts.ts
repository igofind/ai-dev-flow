// 稿件读写：任务目录和文件写入。

import fs from "node:fs"
import path from "node:path"

// 生成任务稿件的目录路径。
export function taskDir(workdir: string, taskID: string): string {
  return path.join(workdir, ".ai-dev-flow", "tasks", taskID)
}

// 创建目录并写入稿件，返回绝对路径。
export function writeDraft(dir: string, fileName: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, content)
  return filePath
}
