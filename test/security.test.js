// 出口脱敏的单元测试：配置 key 逐字打码、sk- 长串打码、短串不误伤。

import test from "node:test";
import assert from "node:assert/strict";
import { collectSecrets, scrubSecrets } from "../src/security.js";

const keyProp = "api" + "Key";

test("已配置的 key 逐字打码（多处出现都打）", () => {
  const secret = "sk-live-1234567890abcdef";
  const out = scrubSecrets(`答案里提到了 ${secret} 和 ${secret}`, [secret]);
  assert.ok(!out.includes(secret));
  assert.ok(out.includes("***"));
});

test("未配置的 sk- 长串也打成 sk-***", () => {
  const fake = "sk-" + "x".repeat(40);
  const out = scrubSecrets(`这是一个 key：${fake} 完`, []);
  assert.equal(out, "这是一个 key：sk-*** 完");
});

test("短的 sk- 串不误伤（如 sk-abc）", () => {
  const out = scrubSecrets("sk-abc 不是 key", []);
  assert.equal(out, "sk-abc 不是 key");
});

test("太短的已配置串不参与逐字打码（避免误伤普通词）", () => {
  const out = scrubSecrets("hello world", ["hello"]);
  assert.equal(out, "hello world");
});

test("空文本与非字符串原样返回", () => {
  assert.equal(scrubSecrets("", ["whatever123"]), "");
  assert.equal(scrubSecrets(null, []), null);
});

test("collectSecrets 收齐提供方/TTS/搜索 key 与 apiHash，过滤短串与空值", () => {
  const cfg = {
    providers: [
      { name: "a", [keyProp]: "key-aaaa-1111" },
      { name: "b", [keyProp]: "short" },
      { name: "c" },
    ],
    ttsApiKey: "tts-key-2222",
    searchApiKey: "search-key-3333",
    apiHash: "hashhashhash",
  };
  const secrets = collectSecrets(cfg);
  assert.ok(secrets.includes("key-aaaa-1111"));
  assert.ok(secrets.includes("tts-key-2222"));
  assert.ok(secrets.includes("search-key-3333"));
  assert.ok(secrets.includes("hashhashhash"));
  assert.ok(!secrets.includes("short"));
});
