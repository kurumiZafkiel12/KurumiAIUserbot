// 日志：同时输出到控制台和按天切分的日志文件（logs/bot-YYYY-MM-DD.log）。
// 处理函数里捕获到的错误必须走 logger.error 记录，不要静默吞掉。

import fs from "node:fs";
import path from "node:path";
import util from "node:util";

function stamp(date = new Date()) {
  return date.toISOString();
}

function dayFile(date = new Date()) {
  return `bot-${date.toISOString().slice(0, 10)}.log`;
}

/**
 * 创建日志器。
 * @param {string} dir 日志目录（相对进程工作目录）
 */
export function createLogger(dir = "logs") {
  const logDir = path.resolve(dir);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // 目录建不出来时只打控制台，不让日志把主程序拖崩。
  }

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
