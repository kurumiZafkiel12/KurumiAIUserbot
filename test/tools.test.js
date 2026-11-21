// v0.8.0 内置工具测试：本地工具纯函数、工具存储、工具门、工具调用循环、联网工具（桩 fetch）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  base64Tool, urlCodecTool, morseTool, hashTool, jsonTool, baseConvertTool, wordCountTool,
  unitConvertTool, dateDiffTool, dateAddTool, randomTool, passwordGenTool, colorTool,
  diceTool, coinTool, drawLotTool, tarotTool, horoscopeTool, almanacTool, worldTimeTool,
  toolGate, executeTool, TOOL_DEFS,
} from "../src/tools.js";
import { ToolStore } from "../src/toolstore.js";
import { chatWithTools } from "../src/toolchat.js";

test("base64 编解码往返", () => {
  const enc = base64Tool("你好，世界", "encode");
  assert.equal(base64Tool(enc, "decode"), "你好，世界");
  assert.throws(() => base64Tool("!!!", "decode"));
});

test("url 编解码与摩斯电码", () => {
  assert.equal(urlCodecTool("a b&c", "encode"), "a%20b%26c");
  assert.equal(urlCodecTool("a%20b", "decode"), "a b");
  assert.equal(morseTool("SOS", "encode"), "... --- ...");
  assert.equal(morseTool("... --- ...", "decode"), "SOS");
});

test("哈希与 JSON 与进制", () => {
  assert.equal(hashTool("hello", "md5"), "5d41402abc4b2a76b9719d911017c592");
  assert.match(hashTool("hello", "sha256"), /^[0-9a-f]{64}$/);
  assert.equal(jsonTool('{"a":1}', "format"), '{\n  "a": 1\n}');
  assert.throws(() => jsonTool("{bad", "format"));
  assert.equal(baseConvertTool("255", 10, 16), "FF");
  assert.equal(baseConvertTool("FF", 16, 2), "11111111");
  assert.throws(() => baseConvertTool("12", 2, 10));
});

test("单位换算与温度", () => {
  assert.match(unitConvertTool(1, "千米", "米"), /1000/);
  assert.match(unitConvertTool(0, "摄氏度", "华氏度"), /32/);
  assert.match(unitConvertTool(1, "斤", "千克"), /0\.5/);
  assert.throws(() => unitConvertTool(1, "米", "千克"));
});

test("日期差与日期加减", () => {
  assert.match(dateDiffTool("2026-01-01", "2026-01-11"), /10 天/);
  assert.match(dateAddTool("2026-01-31", 1), /2026-02-01/);
  assert.throws(() => dateDiffTool("2026/01/01", "2026-01-02"));
});

test("字数统计与颜色换算与密码生成", () => {
  assert.match(wordCountTool("你好 world"), /总字符 8/);
  assert.match(colorTool("#FF0000"), /rgb\(255, 0, 0\)/);
  assert.match(colorTool("rgb(0, 128, 255)"), /#0080FF/);
  const pw = passwordGenTool(20, true);
  assert.equal(pw.length, 20);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[0-9]/);
});

test("骰子/硬币/抽签/塔罗/运势/黄历/世界时间", () => {
  assert.match(diceTool("2d6"), /总计 \d+/);
  assert.throws(() => diceTool("abc"));
  assert.match(coinTool(3), /抛硬币 3 次/);
  assert.match(drawLotTool(), /签/);
  const tarot = tarotTool(3);
  assert.equal(tarot.split("\n").length >= 3, true);
  assert.match(horoscopeTool("狮子座", "Asia/Shanghai"), /狮子座.*运势/);
  assert.throws(() => horoscopeTool("猫座", "Asia/Shanghai"));
  assert.match(almanacTool("Asia/Shanghai"), /干支/);
  assert.match(worldTimeTool("东京", "Asia/Shanghai"), /Asia\/Tokyo/);
  assert.throws(() => worldTimeTool("火星城", "Asia/Shanghai"));
  assert.match(randomTool("pick", null, null, ["甲", "乙"]), /抽中了：(甲|乙)/);
});

test("工具门：需要工具的问题命中、闲聊不命中", () => {
  assert.equal(toolGate("北京今天天气怎么样"), true);
  assert.equal(toolGate("帮我查下汇率"), true);
  assert.equal(toolGate("生成一个密码"), true);
  assert.equal(toolGate("你好呀，今天过得怎么样"), false);
  assert.equal(toolGate(""), false);
});

test("executeTool：注册表执行与未知工具", async () => {
  const ctx = { logger: { error() {} }, outbox: [] };
  assert.equal(await executeTool("base64", { text: "hi", mode: "encode" }, ctx), "aGk=");
  assert.match(await executeTool("nope_tool", {}, ctx), /不存在/);
  assert.ok(TOOL_DEFS.length >= 40, `工具数应不少于 40，实际 ${TOOL_DEFS.length}`);
});

test("ToolStore：提醒与待办的增删查与落盘", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolstore-"));
  const file = path.join(dir, "reminders.json");
  const store = new ToolStore(file);
  const future = new Date(Date.now() + 3600_000).toISOString();
  store.addReminder({ chatId: "100", senderId: "7", text: "开会", at: future });
  store.addReminder({ chatId: "100", senderId: "7", text: "已过期", at: new Date(Date.now() - 1000).toISOString() });
  assert.equal(store.listReminders("100").length, 2);
  const due = store.takeDueReminders(new Date());
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "已过期");
  assert.equal(store.listReminders("100").length, 1);
  store.addTodo("100:7", "买牛奶");
  store.addTodo("100:7", "写周报");
  assert.deepEqual(store.listTodos("100:7"), ["买牛奶", "写周报"]);
  assert.equal(store.doneTodo("100:7", 1), "买牛奶");
  assert.equal(store.doneTodo("100:7", 9), null);
  const reloaded = new ToolStore(file);
  assert.deepEqual(reloaded.listTodos("100:7"), ["写周报"]);
  assert.equal(reloaded.listReminders("100").length, 1);
});

test("chatWithTools：模型调工具后给出最终答案", async () => {
  const calls = [];
  const entry = {
    model: "fake",
    client: {
      chat: {
        completions: {
          create: async (params) => {
            calls.push(params);
            if (calls.length === 1) {
              return {
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "base64", arguments: JSON.stringify({ text: "hi", mode: "encode" }) } }] } }],
              };
            }
            return { choices: [{ message: { content: "编码结果是 aGk=" } }] };
          },
        },
      },
    },
  };
  const ctx = { chatId: "1", senderId: "2", timezone: "Asia/Shanghai", logger: { error() {} }, outbox: [], store: new ToolStore(null) };
  let usage = null;
  const text = await chatWithTools(entry, [{ role: "user", content: "把 hi 做 base64 编码" }], ctx, (u) => { usage = u; });
  assert.equal(text, "编码结果是 aGk=");
  assert.equal(calls.length, 2);
  const secondMsgs = calls[1].messages;
  assert.ok(secondMsgs.some((m) => m.role === "tool" && m.content === "aGk="));
  assert.equal(usage.total_tokens, 15);
});

test("chatWithTools：提供方不支持工具时返回 null（回退流式）", async () => {
  const entry = {
    model: "fake",
    client: { chat: { completions: { create: async () => { throw new Error("unknown parameter: tools"); } } } },
  };
  const ctx = { logger: { error() {} }, outbox: [], store: new ToolStore(null) };
  assert.equal(await chatWithTools(entry, [{ role: "user", content: "天气" }], ctx), null);
});

test("联网工具（桩 fetch）：汇率与 GitHub 搜索", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("open.er-api.com")) {
      return { ok: true, json: async () => ({ result: "success", rates: { CNY: 7.2, JPY: 150 } }) };
    }
    if (u.includes("api.github.com")) {
      return { ok: true, json: async () => ({ items: [{ full_name: "a/b", stargazers_count: 42, language: "JavaScript", description: "demo", html_url: "https://github.com/a/b" }] }) };
    }
    throw new Error(`未预期的请求：${u}`);
  };
  try {
    const { exchangeRateTool, githubSearchTool } = await import("../src/tools.js");
    assert.match(await exchangeRateTool("USD", "CNY", 10), /72/);
    assert.match(await githubSearchTool("userbot"), /a\/b/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
