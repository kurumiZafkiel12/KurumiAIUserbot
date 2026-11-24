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
  toolGate, executeTool, TOOL_DEFS, extractTextToolCalls, stripTextToolCalls,
  resolveStockSymbol, parseYahooChart, parseTencentQuote,
  addReminderTool,
  directToolCommand,
} from "../src/tools.js";
import { ToolStore, reminderFireText, resolveReminderInputUser } from "../src/toolstore.js";
import { Api } from "telegram";
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

test("文本工具调用提取：DeepSeek 式 <tool_call> 块（对象参数与字符串参数都认）", () => {
  const calls = extractTextToolCalls('<tool_call>{"name": "get_weather", "arguments": {"city": "宜春"}}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
  assert.deepEqual(calls[0].args, { city: "宜春" });
  const inner = JSON.stringify({ name: "flip_coin", arguments: JSON.stringify({ times: 2 }) });
  const calls2 = extractTextToolCalls(`前缀 <tool_call>${inner}</tool_call> 后缀`);
  assert.equal(calls2.length, 1);
  assert.deepEqual(calls2[0].args, { times: 2 });
  assert.deepEqual(extractTextToolCalls("普通回答，没有标记。"), []);
  assert.deepEqual(extractTextToolCalls('<tool_call>不是JSON</tool_call>'), []);
});

test("文本工具调用剥离：stripTextToolCalls 去掉标记块只留正文", () => {
  assert.equal(stripTextToolCalls('好的 <tool_call>{"name":"x","arguments":{}}</tool_call>'), "好的");
  assert.equal(stripTextToolCalls('<tool_call>{"name":"x","arguments":{}}</tool_call>'), "");
});

test("工具门：新闻类问题应命中（v0.8.4 补漏）", () => {
  assert.equal(toolGate("最近的新闻"), true);
  assert.equal(toolGate("今天有什么热点"), true);
  assert.equal(toolGate("随便聊聊"), false);
});

test("天气地理编码兜底：Open-Meteo 中文索引缺失时走 Photon 并优先城市条目（宜春实测案例）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes("geocoding-api.open-meteo.com")) return { ok: true, json: async () => ({}) };
    if (url.includes("photon.komoot.io")) {
      return {
        ok: true,
        json: async () => ({
          features: [
            { properties: { name: "宜春市", state: "江西省", type: "county" }, geometry: { coordinates: [115.01, 28.38] } },
            { properties: { name: "宜春", state: "江西省", type: "city" }, geometry: { coordinates: [114.4, 27.83] } },
          ],
        }),
      };
    }
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return {
        ok: true,
        json: async () => ({
          current: { temperature_2m: 18, relative_humidity_2m: 60, weather_code: 0, wind_speed_10m: 5 },
          daily: { time: ["2026-11-21"], temperature_2m_max: [22], temperature_2m_min: [12], weather_code: [0] },
        }),
      };
    }
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    const { weatherTool } = await import("../src/tools.js");
    const out = await weatherTool("宜春");
    assert.match(out, /宜春/);
    assert.match(out, /18°C/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("天气三级兜底：两个地理编码都落空时用 wttr.in 出天气（v0.8.5）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes("geocoding-api.open-meteo.com")) return { ok: true, json: async () => ({}) };
    if (url.includes("photon.komoot.io")) return { ok: true, json: async () => ({ features: [] }) };
    if (url.includes("wttr.in")) {
      return {
        ok: true,
        json: async () => ({
          current_condition: [{ temp_C: "17", humidity: "38", windspeedKmph: "9", weatherDesc: [{ value: "Sunny" }] }],
          nearest_area: [{ areaName: [{ value: "宜春" }], region: [{ value: "江西" }] }],
          weather: [{ date: "2026-11-21", maxtempC: "21", mintempC: "8", hourly: [{ weatherDesc: [{ value: "Sunny" }] }] }],
        }),
      };
    }
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    const { weatherTool } = await import("../src/tools.js");
    const out = await weatherTool("宜春");
    assert.match(out, /宜春（江西）当前：晴，17°C/);
    assert.match(out, /2026-11-21：晴，8–21°C/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("stock_quote：代码解析（中文名/别名/直通/未知）", () => {
  assert.deepEqual(resolveStockSymbol("标普500"), { symbol: "^GSPC", name: "标普500指数" });
  assert.deepEqual(resolveStockSymbol("Spx"), { symbol: "^GSPC", name: "标普500指数" });
  assert.deepEqual(resolveStockSymbol("标普500指数"), { symbol: "^GSPC", name: "标普500指数" });
  assert.deepEqual(resolveStockSymbol("英伟达"), { symbol: "NVDA", name: "英伟达" });
  assert.deepEqual(resolveStockSymbol("NVDA"), { symbol: "NVDA", name: "NVDA" });
  assert.deepEqual(resolveStockSymbol("0700.HK"), { symbol: "0700.HK", name: "0700.HK" });
  assert.deepEqual(resolveStockSymbol("恒生"), { symbol: "^HSI", name: "恒生指数" });
  assert.equal(resolveStockSymbol("不存在的东西"), null);
  assert.equal(resolveStockSymbol(""), null);
});

test("stock_quote：Yahoo chart 解析取最后收盘与前收", () => {
  const data = {
    chart: {
      result: [{
        meta: { currency: "USD", exchangeTimezoneName: "America/New_York", chartPreviousClose: 7000 },
        timestamp: [1795000000, 1795086400, 1795172800],
        indicators: { quote: [{ close: [7100.5, 7175.83, 6910.39], open: [7090, 7160, 7150.39], high: [7120, 7200, 7198.67], low: [7080, 7140, 6882.66] }] },
      }],
    },
  };
  const q = parseYahooChart(data);
  assert.equal(q.close, 6910.39);
  assert.equal(q.prevClose, 7175.83);
  assert.equal(q.open, 7150.39);
  assert.equal(q.high, 7198.67);
  assert.equal(q.low, 6882.66);
  assert.equal(q.currency, "USD");
  assert.match(q.date, /^2026-11-/);
  assert.equal(parseYahooChart({}), null);
  assert.equal(parseYahooChart({ chart: { result: [{ indicators: { quote: [{ close: [null] }] } }] } }), null);
});

test("stock_quote：腾讯行情文本解析（动态定位时间字段）", () => {
  const text = 'v_usINX="200~标普500~.INX~6910.39~7175.83~7150.39~4727416323~0~0~6893.98~0~0~0~0~0~0~0~0~0~7026.48~0~0~0~0~0~0~0~0~0~~2026-11-20 16:35:54~-265.44~-3.70~7198.67~6882.66~USD~4727416323";';
  const q = parseTencentQuote(text);
  assert.equal(q.close, 6910.39);
  assert.equal(q.prevClose, 7175.83);
  assert.equal(q.open, 7150.39);
  assert.equal(q.date, "2026-11-20");
  assert.equal(q.change, -265.44);
  assert.equal(q.pct, -3.7);
  assert.equal(q.high, 7198.67);
  assert.equal(q.low, 6882.66);
  assert.equal(parseTencentQuote(""), null);
});

test("group_history：实时拉取按时间窗过滤、旧→新排序、带时间前缀（v0.0.10）", async () => {
  const def = TOOL_DEFS.find((t) => t.name === "group_history");
  assert.ok(def, "group_history 应已注册");
  const nowSec = Math.floor(Date.now() / 1000);
  // getMessages 返回新→旧：新消息在前
  const fakeMsgs = [
    { date: nowSec - 600, message: "刚说的", sender: { firstName: "乙" } },
    { date: nowSec - 3600, message: "一小时前的", sender: { firstName: "甲" } },
    { date: nowSec - 600, message: "", sender: { firstName: "丙" } }, // 纯媒体无文字，跳过
    { date: nowSec - 600, action: { className: "MessageActionChatAddUser" }, message: "", sender: null }, // 服务消息，跳过
    { date: nowSec - 25 * 3600, message: "昨天的旧消息", sender: { firstName: "甲" } }, // 超出 24 小时窗
  ];
  const ctx = {
    chatId: "-100999",
    timezone: "Asia/Shanghai",
    client: { getMessages: async () => fakeMsgs },
  };
  const out = await def.run({ hours: 24 }, ctx);
  assert.match(out, /实时从 Telegram 拉取/);
  assert.match(out, /甲：一小时前的/);
  assert.match(out, /乙：刚说的/);
  assert.ok(out.indexOf("一小时前的") < out.indexOf("刚说的"), "应按旧→新排序");
  assert.ok(!out.includes("昨天的旧消息"), "超出时间窗的应被过滤");
  assert.match(out, /\[\d{2}-\d{2} \d{2}:\d{2}\] 甲：一小时前的/, "每条应带时间前缀");
  const priv = await def.run({ hours: 24 }, { ...ctx, chatId: "111" });
  assert.match(priv, /私聊/);
});

test("stock_quote：工具门命中股价类问题且工具已注册", () => {
  assert.equal(toolGate("Spx收盘价是多少"), true);
  assert.equal(toolGate("英伟达股价怎么样"), true);
  assert.equal(toolGate("恒生指数今天多少点"), true);
  assert.ok(TOOL_DEFS.some((t) => t.name === "stock_quote"));
});

test("提醒修复（v0.9.15）：工具门命中「定时提醒，1分钟后艾特我」；in_seconds 由代码算时刻；到点文案带 @", async () => {
  assert.equal(toolGate("定时提醒，1分钟后艾特我"), true);
  assert.equal(toolGate("过两小时提醒我开会"), true);
  let saved = null;
  const ctx = {
    chatId: -1001,
    senderId: 42,
    senderName: "柠檬",
    timezone: "Asia/Tokyo",
    store: {
      addReminder: (o) => {
        saved = o;
        return o;
      },
    },
  };
  const before = Date.now();
  const out = await addReminderTool({ text: "艾特我", in_seconds: 60 }, ctx);
  assert.ok(saved, "应写入 store");
  assert.equal(saved.senderName, "柠檬");
  const atMs = new Date(saved.at).getTime();
  assert.ok(atMs >= before + 55_000 && atMs <= Date.now() + 65_000, `at 应约为 60 秒后，实际 ${saved.at}`);
  assert.ok(out.includes("提醒已设"), out);
  const fire = reminderFireText({ senderId: "42", senderName: "柠檬", text: "艾特我" });
  assert.equal(fire, "柠檬 提醒：艾特我");
  assert.equal(reminderFireText({ senderId: "42", senderName: "", text: "x" }), "你 提醒：x");
});

test("resolveReminderInputUser（v0.9.17）：落盘 accessHash 优先；缓存直查；扫会话预热；全失败返回 null", async () => {
  // ① 落盘 hash：不碰 client 就能构建
  const noTouch = { getInputEntity: async () => { throw new Error("不应被调用"); }, getMessages: async () => { throw new Error("不应被调用"); } };
  const u1 = await resolveReminderInputUser(noTouch, { senderId: "42", senderAccessHash: "777", chatId: "-1001" });
  assert.equal(String(u1.userId), "42");
  assert.equal(String(u1.accessHash), "777");
  // ② 缓存直查
  const cached = { getInputEntity: async () => ({ userId: BigInt(42), accessHash: BigInt(888) }), getMessages: async () => [] };
  const u2 = await resolveReminderInputUser(cached, { senderId: "42", senderAccessHash: "", chatId: "-1001" });
  assert.equal(String(u2.accessHash), "888");
  // ③ 直查失败 → 扫会话预热后成功
  let calls = 0;
  const cold = {
    getInputEntity: async () => { calls += 1; if (calls === 1) throw new Error("缓存没有"); return { userId: BigInt(42), accessHash: BigInt(999) }; },
    getMessages: async () => [],
  };
  const u3 = await resolveReminderInputUser(cold, { senderId: "42", senderAccessHash: "", chatId: "-1001" });
  assert.equal(String(u3.accessHash), "999");
  assert.equal(calls, 2);
  // ④ 全失败 → null（调度器退回纯文本）
  const dead = { getInputEntity: async () => { throw new Error("没有"); }, getMessages: async () => { throw new Error("没有"); } };
  assert.equal(await resolveReminderInputUser(dead, { senderId: "42", senderAccessHash: "", chatId: "-1001" }), null);
});

test("directToolCommand（v0.9.18）：裸口令直达，带问法不命中；塔罗结果带牌名", () => {
assert.deepEqual(directToolCommand("掷骰子"), { name: "roll_dice", args: { expr: "1d6" } });
assert.deepEqual(directToolCommand("骰子 2d20"), { name: "roll_dice", args: { expr: "2d20" } });
assert.deepEqual(directToolCommand("塔罗牌"), { name: "tarot", args: {} });
assert.deepEqual(directToolCommand("抽塔罗"), { name: "tarot", args: {} });
assert.deepEqual(directToolCommand("抽签"), { name: "draw_lot", args: {} });
assert.deepEqual(directToolCommand("抛硬币"), { name: "flip_coin", args: { times: 1 } });
assert.deepEqual(directToolCommand("抛硬币 3次"), { name: "flip_coin", args: { times: 3 } });
assert.equal(directToolCommand("塔罗牌怎么玩"), null);
assert.equal(directToolCommand("我想掷骰子"), null);
assert.equal(directToolCommand("抽"), null);
assert.match(tarotTool(1), /^1\. \S+（(正位|逆位)）：/);
});

test("提及实体构造（v0.9.19 回归）：Input 版塞 InputUser 可序列化，非 Input 版抛 CastError", () => {
const inputUser = new Api.InputUser({ userId: BigInt(8842059740), accessHash: BigInt(12345) });
const ent = new Api.InputMessageEntityMentionName({ offset: 0, length: 3, userId: inputUser });
assert.doesNotThrow(() => ent.getBytes());
const bad = new Api.MessageEntityMentionName({ offset: 0, length: 3, userId: inputUser });
assert.throws(() => bad.getBytes());
});

test("v0.9.23 generate_image 工具：未注入通道时如实回未启用，注入后转交描述", async () => {
assert.match(await executeTool("generate_image", { prompt: "一只猫" }, {}), /通道未启用/);
const seen = [];
const out = await executeTool("generate_image", { prompt: "东方明珠夜景" }, { imageGen: async (p) => { seen.push(p); return "图片已经生成并发到当前会话里了。"; } });
assert.deepEqual(seen, ["东方明珠夜景"]);
assert.match(out, /已经生成/);
assert.equal(toolGate("帮我生成一张东方明珠的夜景照片"), true);
assert.equal(toolGate("生产一张东方明珠的实景照"), true);
});
