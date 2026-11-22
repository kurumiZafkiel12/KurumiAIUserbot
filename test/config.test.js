// 配置加载的单元测试：在临时目录里放 config.json，动态 import config.js。
// v0.9.1 起路径锚定项目根目录：用 KURUMI_ROOT_DIR 把根指到临时目录（与 cwd 无关）；
// 每个场景改写同一个 config.json 文件后重新调 loadConfig（它每次都重读文件）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-config-"));
const configFile = path.join(dir, "config.json");
process.env.KURUMI_ROOT_DIR = dir;
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

test("v0.6.0 新字段缺省：破甲空、识图池空、TTS 未配、记录关、搜索未配、无改名", () => {
  if (fs.existsSync(configFile)) fs.rmSync(configFile);
  delete process.env.SEARCH_API_KEY;
  delete process.env.TTS_API_BASE;
  delete process.env.TTS_API_KEY;
  const cfg = loadConfig();
  assert.equal(cfg.poJia, "");
  assert.deepEqual(cfg.visionPool, {});
  assert.equal(cfg.ttsApiBase, "");
  assert.equal(cfg.ttsApiKey, "");
  assert.deepEqual(cfg.voiceBook, {});
  assert.deepEqual(cfg.voicePersona, {});
  assert.deepEqual(cfg.saySwitch, {});
  assert.deepEqual(cfg.voiceSwitch, {});
  assert.deepEqual(cfg.recordGroups, []);
  assert.deepEqual(cfg.recordContextLimit, {});
  assert.equal(cfg.searchApiKey, "");
  assert.equal(cfg.customName, null);
});

test("v0.6.0 新字段解析：破甲/识图池规范化/TTS/音色人格/每群开关/记录/改名", () => {
  writeJson({
    poJia: "破甲内容",
    visionPool: { default: [{ model: "v1", weight: 3 }, "v2"], other: { model: "v3" } },
    ttsApiBase: "https://tts.example/v1",
    ttsApiKey: "tts-key-x",
    voiceBook: { 塔菲: "voice-1" },
    voicePersona: { 塔菲: "活泼一点" },
    saySwitch: { "-1001": true, "-1002": false },
    voiceSwitch: { "-1001": true },
    voiceByChat: { "-1001": "塔菲" },
    voiceByChatUser: { "-1001_42": "塔菲" },
    recordGroups: ["-1001", 123],
    recordContextLimit: { "-1001": 50, bad: "x" },
    searchApiKey: "search-key-y",
    customName: { first: "大肥鱼", last: "狂三" },
  });
  const cfg = loadConfig();
  assert.equal(cfg.poJia, "破甲内容");
  assert.deepEqual(cfg.visionPool.default, [
    { model: "v1", weight: 3 },
    { model: "v2", weight: 7 },
  ]);
  assert.deepEqual(cfg.visionPool.other, [{ model: "v3", weight: 7 }]);
  assert.equal(cfg.ttsApiBase, "https://tts.example/v1");
  assert.equal(cfg.ttsApiKey, "tts-key-x");
  assert.deepEqual(cfg.voiceBook, { 塔菲: "voice-1" });
  assert.deepEqual(cfg.voicePersona, { 塔菲: "活泼一点" });
  assert.deepEqual(cfg.saySwitch, { "-1001": true, "-1002": false });
  assert.deepEqual(cfg.recordGroups, ["-1001", "123"]);
  assert.deepEqual(cfg.recordContextLimit, { "-1001": 50 });
  assert.equal(cfg.searchApiKey, "search-key-y");
  assert.deepEqual(cfg.customName, { first: "大肥鱼" });
});

test("搜索 key 与 TTS 凭证可从 .env 兜底，config.json 优先", () => {
  const setEnv = (k, v) => {
    process.env[k] = v;
  };
  setEnv("SEARCH" + "_API" + "_KEY", "env-search-key");
  setEnv("TTS" + "_API" + "_KEY", "env-tts-key");
  if (fs.existsSync(configFile)) fs.rmSync(configFile);
  let cfg = loadConfig();
  assert.equal(cfg.searchApiKey, "env-search-key");
  assert.equal(cfg.ttsApiKey, "env-tts-key");
  writeJson({ searchApiKey: "json-search-key" });
  cfg = loadConfig();
  assert.equal(cfg.searchApiKey, "json-search-key");
  delete process.env.SEARCH_API_KEY;
  delete process.env.TTS_API_KEY;
});

test("v0.9.0 没填 API 凭证时用内置 Desktop 公开凭证（手机号直登）", () => {
  const id = process.env.TELEGRAM_API_ID;
  const hash = process.env.TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  try {
    const cfg = loadConfig();
    assert.equal(cfg.apiId, 2040);
    assert.equal(cfg.apiCredentialSource, "builtin");
    assert.ok(typeof cfg.apiHash === "string" && cfg.apiHash.length >= 16);
  } finally {
    process.env.TELEGRAM_API_ID = id;
    process.env.TELEGRAM_API_HASH = hash;
  }
  const cfg2 = loadConfig();
  assert.equal(cfg2.apiCredentialSource, "custom");
  assert.equal(cfg2.apiId, 12345);
});

test("v0.9.2 私聊门禁默认值与生产对齐：不写 privateChat 时为 admins，写 all 才全开", () => {
  writeJson({});
  assert.equal(loadConfig().privateChat, "admins");
  writeJson({ privateChat: "all" });
  assert.equal(loadConfig().privateChat, "all");
  writeJson({ privateChat: "admins" });
  assert.equal(loadConfig().privateChat, "admins");
});
