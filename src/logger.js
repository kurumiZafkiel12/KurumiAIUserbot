// 日志：同时输出到控制台和按天切分的日志文件（logs/bot-YYYY-MM-DD.log）。
// 处理函数里捕获到的错误必须走 logger.error 记录，不要静默吞掉。
// 服务器 7×24 跑，日志按天只增不删会把磁盘写满——启动时清理超过保留期（默认 30 天）
// 的旧日志文件（0.2.0）。

import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { rootPath } from "./rootdir.js";

function stamp(date = new Date()) {
  return date.toISOString();
}

function dayFile(date = new Date()) {
  return `bot-${date.toISOString().slice(0, 10)}.log`;
}

/** 日志保留天数：超过就删。 */
export const LOG_RETENTION_DAYS = 30;

/**
 * 删除保留期之外的旧日志文件（bot-YYYY-MM-DD.log）。任何失败都静默——清理是
 * 锦上添花，绝不能反过来拖垮启动。供单测。
 */
export function cleanupOldLogs(logDir, keepDays = LOG_RETENTION_DAYS, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const m = name.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const dayMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (!Number.isFinite(dayMs)) continue;
    if (now - dayMs >= keepDays * 86400_000) {
      try {
        fs.unlinkSync(path.join(logDir, name));
        removed.push(name);
      } catch {
        // 单个删不掉就算了，明天启动再试。
      }
    }
  }
  return removed;
}

/**
 * 创建日志器。
 * @param {string} dir 日志目录（相对路径按项目根目录解析，不受启动目录影响）
 */
export function createLogger(dir = "logs") {
  const logDir = path.isAbsolute(dir) ? dir : rootPath(dir);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // 目录建不出来时只打控制台，不让日志把主程序拖崩。
  }
  cleanupOldLogs(logDir);

  function write(level, args) {
    const line = `[${stamp()}] [${level}] ${util.format(...args)}`;
    if (level === "ERROR") console.error(line);
    else console.log(line);
    try {
      fs.appendFileSync(path.join(logDir, dayFile()), line + "\n", "utf-8");
    } catch {
      // 写文件失败同样不影响主流程。
    }
  }

  return {
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
  };
}
