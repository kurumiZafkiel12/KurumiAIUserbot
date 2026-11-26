// 提供方池的单元测试：禁用跳过、chat 的 usage 采集与安全重试。
// ProviderPool 会给每个条目建真实 OpenAI 客户端（不发请求），测试里把 entry.client 换成假的。

import test from "node:test";
import assert from "node:assert/strict";
import { ProviderPool, displayModelName } from "../src/providers.js";

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

test("识图专用提供方不进聊天池，但 getByName 查得到、识图调用可用", async () => {
  const pool = new ProviderPool(
    [
      { name: "chat", baseURL: "https://a.example/v1", model: "m-chat", weight: 1 },
      { name: "vis", baseURL: "https://v.example/v1", model: "m-vis", weight: 1, vision: true },
      { name: "img", baseURL: "https://i.example/v1", model: "m-img", weight: 1, image: true },
    ],
    silentLogger,
  );
  assert.deepEqual(pool.chatEntries().map((e) => e.name), ["chat"]);
  assert.deepEqual(pool.available().map((e) => e.name), ["chat"]);
  assert.equal(pool.enabledCount(), 1);
  const picked = pool.pick(new Set(), "vis");
  assert.equal(picked.name, "chat", "preferred 指向识图专用提供方也应跳过");
  const vis = pool.getByName("vis");
  assert.equal(vis.vision, true);
  vis.client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "红色" } }] }) } } };
  const text = await pool.visionChat(vis, "m-vis", [{ role: "user", content: [] }]);
  assert.equal(text, "红色");
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

test("0.0.4 chat 带 max_tokens 上限；接口不认时去掉上限重试", async () => {
  const pool = makePool();
  const entry = pool.getByName("a");
  let seenParams = null;
  entry.client = {
    chat: {
      completions: {
        create: async (params) => {
          seenParams = params;
          return streamOf([{ choices: [{ delta: { content: "答" } }] }]);
        },
      },
    },
  };
  await pool.chat(entry, [{ role: "user", content: "hi" }], null, null);
  assert.equal(seenParams.max_tokens, 4096, "应带输出上限");

  let calls = 0;
  entry.client = {
    chat: {
      completions: {
        create: async (params) => {
          calls += 1;
          if (params.max_tokens) throw new Error("max_tokens not supported");
          return streamOf([{ choices: [{ delta: { content: "答" } }] }]);
        },
      },
    },
  };
  const text = await pool.chat(entry, [{ role: "user", content: "hi" }], null, null);
  assert.equal(text, "答");
  assert.equal(calls, 3, "带上限两次被拒后，去掉上限第三次成功");
});

test("0.0.4 markFailure：内容风控拒绝不进冷却，普通失败照常冷却", () => {
  const pool = makePool();
  const a = pool.getByName("a");
  pool.markFailure(a, new Error("400 Content Exists Risk (request_id: x)"));
  assert.equal(a.cooldownUntil, 0, "风控拒绝不应进冷却");
  assert.ok(a.lastError.includes("Content Exists Risk"), "错误仍要记录");
  const c = pool.getByName("c");
  pool.markFailure(c, new Error("500 boom"));
  assert.ok(c.cooldownUntil > Date.now(), "普通失败应进冷却");
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

test("生图提供方不进聊天池挑选，但能被 firstImageProvider 找到", () => {
  const pool = new ProviderPool(
    [
      { name: "chat", baseURL: "https://a.example/v1", model: "m-chat", weight: 1 },
      { name: "img", baseURL: "https://i.example/v1", model: "m-img", weight: 100, image: true },
    ],
    silentLogger,
  );
  assert.deepEqual(pool.available().map((e) => e.name), ["chat"]);
  assert.equal(pool.pick(new Set(), "img").name, "chat"); // preferred 指向生图也被跳过
  assert.equal(pool.enabledCount(), 1); // 生图不算聊天提供方
  assert.deepEqual(pool.chatEntries().map((e) => e.name), ["chat"]);
  assert.equal(pool.firstImageProvider().name, "img");
  assert.equal(pool.getByName("img").image, true);
});

test("visionChat 用指定模型发非流式带图请求并回传 usage", async () => {
  const pool = makePool();
  const entry = pool.getByName("a");
  let seenParams = null;
  entry.client = {
    chat: {
      completions: {
        create: async (params) => {
          seenParams = params;
          return {
            choices: [{ message: { content: "图里是一只猫" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  let usage = null;
  const text = await pool.visionChat(
    entry,
    "vision-model",
    [{ role: "user", content: [{ type: "text", text: "这是什么" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }] }],
    (u) => {
      usage = u;
    },
  );
  assert.equal(text, "图里是一只猫");
  assert.equal(seenParams.model, "vision-model");
  assert.equal(seenParams.stream, false);
  assert.equal(usage.total_tokens, 15);
});

test("pick 同步预留名额：上限 1 时第二次 pick 返回 null，失败回滚后可再 pick（K062-04）", () => {
  const pool = new ProviderPool(
    [{ name: "a", baseURL: "https://a.example/v1", model: "m-a", apiKey: "k", dailyLimit: 1 }],
    silentLogger,
  );
  const first = pool.pick();
  assert.ok(first);
  assert.equal(pool.pick(), null, "名额已被在途预留占住，并发不能再放行");
  pool.markFailure(first, new Error("boom"));
  assert.equal(first.counter.snapshot().count, 0, "失败不计用量");
  assert.equal(pool.pick(), null, "失败后进冷却，冷却内不可挑中（现有失败逻辑不变）");
  first.cooldownUntil = 0; // 模拟冷却到期
  const again = pool.pick();
  assert.ok(again, "预留已回滚，冷却到期后可重新挑中");
  pool.markSuccess(again);
  assert.equal(again.counter.snapshot().count, 1);
  assert.equal(pool.pick(), null, "结算后额度用满");
});

test("inheritStateFrom：按名继承今日用量与未到期的失败冷却（K062-02）", () => {
  const mk = () =>
    new ProviderPool(
      [{ name: "a", baseURL: "https://a.example/v1", model: "m-a", apiKey: "k", dailyLimit: 5 }],
      silentLogger,
    );
  const old = mk();
  const e = old.pick();
  old.markSuccess(e);
  e.cooldownUntil = Date.now() + 60_000;
  const fresh = mk();
  fresh.inheritStateFrom(old);
  assert.equal(fresh.entries[0].counter.snapshot().count, 1, "今日已用必须继承");
  assert.ok(fresh.entries[0].cooldownUntil > Date.now(), "未到期冷却必须继承");
});

test("reserve：预留占满或冷却中返回 false（K062-03）", () => {
  const pool = new ProviderPool(
    [{ name: "a", baseURL: "https://a.example/v1", model: "m-a", apiKey: "k", dailyLimit: 1 }],
    silentLogger,
  );
  const e = pool.entries[0];
  assert.equal(pool.reserve(e), true);
  assert.equal(pool.reserve(e), false, "预留占满后不可再预留");
  pool.release(e);
  e.cooldownUntil = Date.now() + 60_000;
  assert.equal(pool.reserve(e), false, "冷却中不可预留");
});

test("配置不完整的提供方被跳过时，日志只打安全字段、绝不带 apiKey（K062-05）", () => {
  const warns = [];
  const logger = { info() {}, warn: (m) => warns.push(String(m)), error() {} };
  const fakeKey = "FAKE-KEY-SHOULD-NEVER-BE-LOGGED";
  const pool = new ProviderPool(
    [
      { name: "bad", baseURL: "https://bad.example/v1", apiKey: fakeKey }, // 缺 model
      { name: "ok", baseURL: "https://ok.example/v1", model: "m-ok", apiKey: "whatever" },
    ],
    logger,
  );
  assert.deepEqual(pool.entries.map((e) => e.name), ["ok"]);
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes(fakeKey), "日志里不能出现 apiKey 明文");
  assert.ok(warns[0].includes("bad"), "日志应包含提供方名字");
  assert.ok(warns[0].includes("model"), "日志应指明缺失字段名");
});

test("0.1.5 displayModelName：剥渠道前缀只留本体名", () => {
  assert.equal(displayModelName("[满血F]gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(displayModelName("[premium]gemini-3-pro-preview"), "gemini-3-pro-preview");
  assert.equal(displayModelName("[次]deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(displayModelName("[官逆B]gemini-3-pro-preview-thinking"), "gemini-3-pro-preview-thinking");
  assert.equal(displayModelName("gpt-image-2"), "gpt-image-2");
  assert.equal(displayModelName("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(displayModelName(""), "");
  assert.equal(displayModelName(null), "");
});
