// 项目根目录锚点（v0.9.1）：所有落盘文件（.env、config.json、.ai-session、
// 记事本/档案/状态/用量/日志等）一律按项目根目录定位，不再按进程启动目录（cwd）。
// 否则从别的目录启动时：改好的 .env 读不到、号主命令保存的 config.json 会写去
// 启动目录、登录存的 session 下次找不到——表现全是「保存一直没用」。
// 测试与特殊部署可用环境变量 KURUMI_ROOT_DIR 显式指定根目录。

import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = process.env.KURUMI_ROOT_DIR
  ? path.resolve(process.env.KURUMI_ROOT_DIR)
  : path.resolve(SRC_DIR, "..");

export function rootPath(...parts) {
  return path.join(ROOT_DIR, ...parts);
}
