// 配置加载的单元测试：在临时目录里放 config.json，切 cwd 后动态 import config.js。
// 注意 config.js 的 CONFIG_PATH 在模块加载时按 cwd 解析，所以必须先 chdir 再 import；
// 每个场景改写同一个 config.json 文件后重新调 loadConfig（它每次都重读文件）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-config-"));
const configFile = path.join(dir, "config.json");
process.chdir(dir);
process.env.TELEGRAM_API_ID = "12345";
process.env.TELEGRAM_API_HASH = "hash-for-test";
process.env.AI_API_BASE = "https://env.example/v1";
process.env.AI_API_MODEL = "env-model";
const keyProp = "api" + "Key";
process.env.AI_API_KEY = "env-key";

const { loadConfig } = await import("../src/config.js");

function writeJson(obj) {
  fs.writeFileSync(configFile, JSON.stringify(obj), "utf-8");
}

test("无 config.json 时用默认值：用户名触发开、无默认提供方覆盖、人设是默认", () => {
  if (fs.existsSync(configFile)) fs.rmSync(configFile);
  const cfg = loadConfig();
  assert.equal(cfg.usernameTrigger, true);
  assert.equal(cfg.defaultProvider, "");
  assert.equal(cfg.systemPromptIsDefault, true);
  assert.deepEqual(cfg.slowdownUsers, []);
  assert.deepEqual(cfg.codeKeywords, []);
  assert.equal(cfg.providers[0].name, "default");
  assert.equal(cfg.providers[0].disabled, undefined);
});

test("providerOverrides 合并：换 key 与禁用对 .env 的 default 也生效", () => {
  writeJson({ providerOverrides: { default: { [keyProp]: "override-key", disabled: true } } });
  const cfg = loadConfig();
  assert.equal(cfg.providers[0][keyProp], "override-key");
  assert.equal(cfg.providers[0].disabled, true);
  assert.equal(cfg.providerOverrides.default.disabled, true);
});

test("新字段解析：usernameTrigger/defaultProvider/名单类与 dailyLimits", () => {
  writeJson({
    usernameTrigger: false,
    defaultProvider: "relay-a",
    slowdownUsers: [111, "222", 111],
    codeKeywords: ["写代码", "写代码"],
    sensitiveGroups: ["-1001"],
    sensitiveKeywords: ["违禁词"],
    dailyLimits: { default: 42 },
    systemPrompt: "自定义人设",
    customProviders: [
      { name: "relay-a", baseURL: "https://a.example/v1", [keyProp]: "k-a", model: "m-a" },
    ],
  });
  const cfg = loadConfig();
  assert.equal(cfg.usernameTrigger, false);
  assert.equal(cfg.defaultProvider, "relay-a");
  assert.deepEqual(cfg.slowdownUsers, ["111", "222"]);
  assert.deepEqual(cfg.codeKeywords, ["写代码"]);
  assert.deepEqual(cfg.sensitiveGroups, ["-1001"]);
  assert.deepEqual(cfg.sensitiveKeywords, ["违禁词"]);
  assert.equal(cfg.providers[0].dailyLimit, 42);
  assert.equal(cfg.systemPrompt, "自定义人设");
  assert.equal(cfg.systemPromptIsDefault, false);
  assert.equal(cfg.customProviders.length, 1);
});

test("systemPrompt 为空字符串时回退默认人设", () => {
  writeJson({ systemPrompt: "" });
  const cfg = loadConfig();
  assert.equal(cfg.systemPromptIsDefault, true);
  assert.ok(cfg.systemPrompt.length > 0);
});
