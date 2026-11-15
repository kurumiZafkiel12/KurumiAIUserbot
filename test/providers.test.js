// 提供方池的单元测试：禁用跳过、chat 的 usage 采集与安全重试。
// ProviderPool 会给每个条目建真实 OpenAI 客户端（不发请求），测试里把 entry.client 换成假的。

import test from "node:test";
import assert from "node:assert/strict";
import { ProviderPool } from "../src/providers.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function makePool() {
  return new ProviderPool(
    [
      { name: "a", baseURL: "https://a.example/v1", model: "m-a", weight: 1 },
      { name: "b", baseURL: "https://b.example/v1", model: "m-b", weight: 1, disabled: true },
      { name: "c", baseURL: "https://c.example/v1", model: "m-c", weight: 1 },
    ],
    silentLogger,
  );
}

function streamOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

test("被禁用的提供方不参与挑选，preferred 指向它也跳过", () => {
  const pool = makePool();
  assert.equal(pool.enabledCount(), 2);
  const names = pool.available().map((e) => e.name).sort();
  assert.deepEqual(names, ["a", "c"]);
  const picked = pool.pick(new Set(), "b");
  assert.notEqual(picked.name, "b");
  // getByName 仍能查到禁用条目（命令层要靠它展示/启用）
  assert.equal(pool.getByName("b").disabled, true);
});

test("chat 采集末尾 usage 并通过 onUsage 回调", async () => {
  const pool = makePool();
  const entry = pool.getByName("a");
  let seenParams = null;
  entry.client = {
    chat: {
      completions: {
        create: async (params) => {
          seenParams = params;
          return streamOf([
            { choices: [{ delta: { content: "你" } }] },
            { choices: [{ delta: { content: "好" } }] },
            { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
          ]);
        },
      },
    },
  };
  let usage = null;
  const text = await pool.chat(entry, [{ role: "user", content: "hi" }], null, (u) => (usage = u));
  assert.equal(text, "你好");
  assert.deepEqual(seenParams.stream_options, { include_usage: true });
  assert.equal(usage.total_tokens, 13);
});

test("chat 带 usage 选项被接口拒绝时，去掉选项重试一次（还没吐字）", async () => {
  const pool = makePool();
  const entry = pool.getByName("a");
  let calls = 0;
  entry.client = {
    chat: {
      completions: {
        create: async (params) => {
          calls += 1;
          if (params.stream_options) throw new Error("stream_options not supported");
          return streamOf([{ choices: [{ delta: { content: "答" } }] }]);
        },
      },
    },
  };
  const text = await pool.chat(entry, [{ role: "user", content: "hi" }], null, null);
  assert.equal(text, "答");
  assert.equal(calls, 2);
});

test("chat 已吐字后断流不重试（防重复发内容）", async () => {
  const pool = makePool();
  const entry = pool.getByName("a");
  let calls = 0;
  entry.client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          return (async function* () {
            yield { choices: [{ delta: { content: "一半" } }] };
            throw new Error("connection reset");
          })();
        },
      },
    },
  };
  await assert.rejects(() => pool.chat(entry, [{ role: "user", content: "hi" }], null, null), /connection reset/);
  assert.equal(calls, 1);
});
