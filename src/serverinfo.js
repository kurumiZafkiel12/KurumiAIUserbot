// 服务器状态文本：数据由调用方从 node:os / process 采集后注入，这里只负责拼文案，
// 这样格式可以脱离真实机器单测。

function fmtMB(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}M`;
}

function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/**
 * 拼服务器状态文本。
 * @param {object} info
 * @param {string} info.hostname 主机名
 * @param {string} info.platform 系统（如 Linux）
 * @param {string} info.release 内核/系统版本
 * @param {number} info.cpus CPU 核数
 * @param {number[]} info.loadavg 负载 [1分, 5分, 15分]
 * @param {number} info.totalMemBytes 内存总量（字节）
 * @param {number} info.freeMemBytes 可用内存（字节）
 * @param {number} info.uptimeSec 系统运行时长（秒）
 * @param {number} info.procMemBytes 本进程内存 RSS（字节）
 * @param {number} info.procUptimeSec 本进程运行时长（秒）
 * @param {string} info.nodeVersion Node 版本
 * @returns {string}
 */
export function formatServerInfo(info) {
  const load = (info.loadavg || []).map((n) => Number(n || 0).toFixed(2)).join(" / ");
  return [
    "服务器状态：",
    `主机名：${info.hostname}`,
    `系统：${info.platform} ${info.release}（${info.cpus} 核）`,
    `运行时长：${fmtUptime(info.uptimeSec)}`,
    `负载：${load}`,
    `内存：共 ${fmtMB(info.totalMemBytes)}，可用 ${fmtMB(info.freeMemBytes)}`,
    `本进程：内存 ${fmtMB(info.procMemBytes)}，已运行 ${fmtUptime(info.procUptimeSec)}`,
    `Node：${info.nodeVersion}`,
  ].join("\n");
}
