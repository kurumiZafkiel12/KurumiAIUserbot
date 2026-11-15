// 服务器状态文案格式的单元测试（数据注入，不碰真实机器）。

import test from "node:test";
import assert from "node:assert/strict";
import { formatServerInfo } from "../src/serverinfo.js";

test("formatServerInfo 含全部关键字段", () => {
  const text = formatServerInfo({
    hostname: "vps-1",
    platform: "Linux",
    release: "6.1.0",
    cpus: 2,
    loadavg: [0.5, 0.25, 0.1],
    totalMemBytes: 1024 * 1024 * 1024,
    freeMemBytes: 512 * 1024 * 1024,
    uptimeSec: 90061, // 1 天 1 小时多
    procMemBytes: 80 * 1024 * 1024,
    procUptimeSec: 3661,
    nodeVersion: "v20.0.0",
  });
  assert.match(text, /主机名：vps-1/);
  assert.match(text, /系统：Linux 6\.1\.0（2 核）/);
  assert.match(text, /运行时长：1 天 1 小时/);
  assert.match(text, /负载：0\.50 \/ 0\.25 \/ 0\.10/);
  assert.match(text, /内存：共 1024M，可用 512M/);
  assert.match(text, /本进程：内存 80M，已运行 1 小时 1 分/);
  assert.match(text, /Node：v20\.0\.0/);
});

test("formatServerInfo 短运行时长格式", () => {
  const text = formatServerInfo({
    hostname: "h",
    platform: "Linux",
    release: "1",
    cpus: 1,
    loadavg: [0, 0, 0],
    totalMemBytes: 0,
    freeMemBytes: 0,
    uptimeSec: 125,
    procMemBytes: 0,
    procUptimeSec: 59,
    nodeVersion: "v20",
  });
  assert.match(text, /运行时长：2 分/);
});
