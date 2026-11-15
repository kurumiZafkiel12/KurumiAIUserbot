// handlers 主链路回归测试（审计 K062 系列）：真实 createHandler/ProviderPool +
// 假 Telegram/模型。必须在 import 源码前 chdir 到临时目录——config.js 的
// CONFIG_PATH 在模块加载时按 cwd 定格，号主命令落盘不能污染仓库根目录。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-handlers-test-"));
process.chdir(tmpRoot);

const { createHandler } = await import("../src/handlers.js");
const { ProviderPool } = await import("../src/providers.js");
const { ConversationStore } = await import("../src/context.js");
const { PendingSelections } = await import("../src/pending.js");
const { GroupRecords } = await import("../src/records.js");
const { Notebook } = await import("../src/notebook.js");
const { UserProfiles } = await import("../src/profiles.js");
const { RuntimeState } = await import("../src/state.js");
const { UsageStats } = await import("../src/usagestats.js");

const silentLogger = () => {
  const logs = [];
  return {
    logs,
    info: (m) => logs.push({ level: "info", text: String(m) }),
    warn: (m) => logs.push({ level: "warn", text: String(m) }),
    error: (m) => logs.push({ level: "error", text: String(m) }),
  };
};

/**
 * 造一套 handler + 替身。options:
 * - config: 覆盖默认 config 的字段
 * - model: 模型桩 async (params, callIndex) => 流式生成器/非流式结果/字符串
 * - editHook: (peer, payload, state, callIndex) => 自定义 editMessage 行为
 * - nowFn: pending 时钟（默认真实时间）
 */
function fixture(options = {}) {
  const logger = silentLogger();
  const def = {
    name: "default",
    model: "mock-model",
    baseURL: "https://offline.invalid/v1",
    apiKey: "SYNTHETIC-KEY-FOR-TESTS",
    dailyLimit: 0,
  };
  const config = {
    ownerId: "111",
    adminIds: ["222"],
    privateChat: "all",
    myUsername: "mybot",
    usernameTrigger: true,
    providers: [def],
    blacklist: [],
    ignoreSenderIds: [],
    slowdownUsers: [],
    codeKeywords: [],
    sensitiveGroups: [],
    sensitiveKeywords: [],
    systemPrompt: "测试用人设。",
    systemPromptIsDefault: true,
    cooldownSeconds: 0,
    defaultProvider: "default",
    timezone: "UTC",
    recordGroups: [],
    recordContextLimit: {},
    visionPool: {},
    voiceBook: {},
    voiceByChatUser: {},
    voiceByChat: {},
    voiceSwitch: {},
    saySwitch: {},
    providerOverrides: {},
    dailyLimits: {},
    customProviders: [],
    ...(options.config || {}),
  };
  const pool = new ProviderPool(config.providers, logger);
  const modelCalls = [];
  const stubPool = (p) => {
    for (const entry of p.entries) {
      entry.client = {
        models: { list: async () => ({ data: [{ id: entry.model }] }) },
        chat: {
          completions: {
            create: async (params) => {
              modelCalls.push(params);
              if (options.model) return options.model(params, modelCalls.length);
              const answer = options.answer ?? "离线回答。";
              if (!params.stream) return { choices: [{ message: { content: answer } }] };
              return (async function* () {
                for (const d of options.deltas || [answer]) {
                  yield { choices: [{ delta: { content: d } }] };
                }
              })();
            },
          },
        },
      };
    }
  };
  stubPool(pool);
  let currentPool = pool;

  let messageId = 500;
  const sends = [];
  const edits = [];
  const files = [];
  const sentState = new Map();
  const client = {
    sendMessage: async (peer, payload) => {
      const m = { id: ++messageId, message: payload.message, peerId: peer, replyTo: payload.replyTo };
      sends.push(m);
      sentState.set(m.id, m.message);
      return m;
    },
    editMessage: async (peer, payload) => {
      edits.push({ ...payload });
      if (options.editHook) return options.editHook(peer, payload, sentState, edits.length);
      if (options.rejectDuplicateEdit && sentState.get(payload.message) === payload.text) {
        throw new Error("MESSAGE_NOT_MODIFIED");
      }
      sentState.set(payload.message, payload.text);
      return { id: payload.message };
    },
    sendFile: async (peer, opts) => {
      files.push({ peer, ...opts });
      return { id: ++messageId };
    },
    deleteMessages: async () => {},
    downloadMedia: async () => Buffer.from("fake-photo-bytes"),
    invoke: async () => {
      throw new Error("offline");
    },
  };

  const store = new ConversationStore(20);
  const pending = new PendingSelections(options.nowFn ? { nowFn: options.nowFn } : {});
  const recordsPath = path.join(tmpRoot, `records-${Math.random().toString(36).slice(2)}.json`);
  const records = new GroupRecords(recordsPath);
  const notebookPath = path.join(tmpRoot, `facts-${Math.random().toString(36).slice(2)}.json`);
  const notebook = new Notebook(notebookPath);
  const profiles = new UserProfiles(null);
  const state = new RuntimeState(null);
  const usageStats = new UsageStats(null);

  const handler = createHandler({
    client,
    config,
    pool,
    logger,
    store,
    pending,
    records,
    notebook,
    profiles,
    state,
    usageStats,
    startedAt: Date.now(),
    selfId: "9999",
    splitDelayMs: 0,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    ...(options.wireReload
      ? {
          // 仿 index.js 的 reloadRuntime：重建池 + 继承旧池状态（K062-02 的被测路径）
          reloadRuntime: () => {
            const fresh = new ProviderPool(config.providers, logger);
            stubPool(fresh);
            fresh.inheritStateFrom(currentPool);
            currentPool = fresh;
            return { config, pool: fresh };
          },
        }
      : {}),
    ...(options.deps || {}),
  });

  function event(text, { sender = "111", chat = null, group = false, photo = false, reply = null, id = 10 } = {}) {
    const chatId = chat ?? (group ? "-100777" : String(sender));
    const message = {
      id,
      message: text,
      out: false,
      senderId: sender,
      chatId,
      peerId: group ? { channelId: chatId.replace(/^-100/, "") } : { userId: String(sender) },
    };
    if (photo) message.photo = { className: "Photo" };
    if (reply) {
      message.replyTo = { replyToMsgId: reply.id || 1 };
      message.getReplyMessage = async () => reply;
    }
    return { message, getSender: async () => ({ firstName: "测试用户" }) };
  }

  return { handler, event, pool, getPool: () => currentPool, config, store, pending, records, notebook, profiles, state, sends, edits, files, sentState, modelCalls, logger, recordsPath, notebookPath };
}

// ================= K062-01：敏感 pending 过期墓碑 =================

test("K062-01 私聊：换key 待办过期后发来的 key 被吞，不进模型、不进上下文", async () => {
  let now = Date.now();
  const f = fixture({ nowFn: () => now });
  await f.handler(f.event("/ai 换key"));
  await f.handler(f.event("1"));
  assert.equal(f.pending.peek("111", "111").entry.kind, "换key");
  now += 60_001; // 待办过期
  const credential = "FAKE-CREDENTIAL-ARRIVING-LATE";
  await f.handler(f.event(credential));
  assert.equal(f.modelCalls.length, 0, "迟到的 key 绝不能发给模型");
  assert.ok(
    !f.store.get("111", "111").some((m) => m.content.includes(credential)),
    "迟到的 key 不能进对话上下文",
  );
  assert.ok(
    f.sends.some((m) => m.message.includes("已忽略") && m.message.includes("不会发给模型")),
    "应回固定忽略提示",
  );
  assert.ok(!f.sends.some((m) => m.message.includes(credential)), "提示里不能回显 key");
});

test("K062-01 群聊：换搜索key 过期后发来的 key 不写群记录、也不进别人的系统上下文", async () => {
  let now = Date.now();
  const group = "-100777";
  const f = fixture({ nowFn: () => now, config: { recordGroups: [group] } });
  await f.handler(f.event("/ai 换搜索key", { group: true, chat: group }));
  await f.handler(f.event("1", { group: true, chat: group }));
  now += 60_001;
  const credential = "FAKE-SEARCH-CREDENTIAL-LATE";
  await f.handler(f.event(credential, { group: true, chat: group }));
  assert.equal(f.records.recent(group, 10).length, 0, "被吞消息不能写进群记录");
  if (fs.existsSync(f.recordsPath)) {
    assert.ok(!fs.readFileSync(f.recordsPath, "utf-8").includes(credential), "群记录落盘也不能有这条凭证");
  }
  // 另一位群友随后提问：系统上下文（带群记录）里不能有这条凭证
  await f.handler(f.event("@mybot 你好", { group: true, chat: group, sender: "333" }));
  assert.equal(f.modelCalls.length, 1);
  assert.ok(!f.modelCalls[0].messages[0].content.includes(credential));
});

test("K062-01 墓碑：吞掉迟到消息后，下一条普通消息也吞一条，之后恢复正常", async () => {
  let now = Date.now();
  const f = fixture({ nowFn: () => now });
  await f.handler(f.event("/ai 换key"));
  await f.handler(f.event("1"));
  now += 60_001;
  await f.handler(f.event("FAKE-CREDENTIAL-PART-1")); // 迟到消息：吞 + 立墓碑
  assert.equal(f.modelCalls.length, 0);
  await f.handler(f.event("FAKE-CREDENTIAL-PART-2")); // 墓碑期内：再吞一条并清墓碑
  assert.equal(f.modelCalls.length, 0, "墓碑期内的下一条也不能发给模型");
  assert.ok(
    !f.store.get("111", "111").some((m) => m.content.includes("FAKE-CREDENTIAL")),
    "两段凭证都不能进上下文",
  );
  await f.handler(f.event("你好")); // 墓碑已清：恢复正常聊天
  assert.equal(f.modelCalls.length, 1);
});

// ================= K062-02/03/04：额度完整性 =================

const limitedProvider = (extra = {}) => ({
  name: "default",
  model: "mock-model",
  baseURL: "https://offline.invalid/v1",
  apiKey: "SYNTHETIC-KEY-FOR-TESTS",
  dailyLimit: 1,
  ...extra,
});

test("K062-04 并发：每日上限 1 时两个用户同时提问只放行一次模型调用", async () => {
  let releaseGate;
  const gate = new Promise((r) => {
    releaseGate = r;
  });
  const f = fixture({
    config: { providers: [limitedProvider()] },
    model: async (params) => {
      await gate;
      if (!params.stream) return { choices: [{ message: { content: "答" } }] };
      return (async function* () {
        yield { choices: [{ delta: { content: "答" } }] };
      })();
    },
  });
  const group = "-100777";
  const p1 = f.handler(f.event("@mybot 问题一", { group: true, chat: group, sender: "333" }));
  const p2 = f.handler(f.event("@mybot 问题二", { group: true, chat: group, sender: "444" }));
  for (let i = 0; i < 100 && f.modelCalls.length < 1; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(f.modelCalls.length, 1, "上限 1 时并发只能有一次模型调用在途");
  releaseGate();
  await Promise.all([p1, p2]);
  assert.equal(f.modelCalls.length, 1, "另一个请求应被额度挡下，不得补发调用");
  assert.equal(f.pool.entries[0].counter.snapshot().count, 1);
});

test("K062-02 热重载：普通用户换音色触发重载后，今日已用额度不清零", async () => {
  const group = "-100777";
  const f = fixture({
    wireReload: true,
    config: {
      providers: [limitedProvider()],
      voiceBook: { A: "voice-id-a" },
      voiceSwitch: { [group]: true },
    },
  });
  await f.handler(f.event("@mybot 你好", { group: true, chat: group, sender: "333" }));
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.getPool().entries[0].counter.snapshot().count, 1);
  await f.handler(f.event("@mybot 换音色 A", { group: true, chat: group, sender: "333" }));
  assert.equal(f.getPool().entries[0].counter.snapshot().count, 1, "重载后额度必须继承，不能清零");
  await f.handler(f.event("@mybot 再问一句", { group: true, chat: group, sender: "333" }));
  assert.equal(f.modelCalls.length, 1, "额度已满时重载后也不能再放行");
});

test("K062-03 识图：每日上限已满时不再调用识图模型", async () => {
  const f = fixture({
    config: {
      providers: [limitedProvider()],
      visionPool: { default: [{ model: "mock-vision", weight: 1 }] },
    },
  });
  const picked = f.pool.pick();
  f.pool.markSuccess(picked); // 今日已用 1/1
  assert.equal(f.pool.getByName("default").counter.snapshot().count, 1);
  await f.handler(f.event("@mybot 请识别图片", { group: true, chat: "-100777", sender: "333", photo: true }));
  assert.equal(f.modelCalls.length, 0, "上限已满时识图必须 0 调用");
});

test("K062-03 识图：失败冷却期内不再调用识图模型", async () => {
  const f = fixture({
    config: { visionPool: { default: [{ model: "mock-vision", weight: 1 }] } },
  });
  f.pool.getByName("default").cooldownUntil = Date.now() + 30_000;
  await f.handler(f.event("@mybot 请识别图片", { group: true, chat: "-100777", sender: "333", photo: true }));
  assert.equal(f.modelCalls.length, 0, "冷却期内识图必须 0 调用");
});

test("K062-03 识图：正常识图成功后计入每日用量", async () => {
  const f = fixture({
    config: { visionPool: { default: [{ model: "mock-vision", weight: 1 }] } },
  });
  await f.handler(f.event("@mybot 请识别图片", { group: true, chat: "-100777", sender: "333", photo: true }));
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.modelCalls[0].model, "mock-vision");
  assert.equal(f.pool.getByName("default").counter.snapshot().count, 1);
});

// ================= K062-08/09：流式编辑收尾 =================

test("K062-08 超长答案：首个编辑与流式部分文本相同（MESSAGE_NOT_MODIFIED）时尾段不丢", async () => {
  const longAnswer = "长".repeat(4500);
  const f = fixture({ rejectDuplicateEdit: true, deltas: [longAnswer] });
  await f.handler(f.event("讲长一点", { sender: "333" }));
  const placeholder = f.sends[0];
  assert.equal(f.sentState.get(placeholder.id), longAnswer.slice(0, 4000), "占位应停在答案前 4000 字");
  const tail = f.sends.slice(1).map((m) => m.message).join("");
  assert.equal(tail, longAnswer.slice(4000), "超出上限的尾段必须续发，不能丢");
});

test("K062-08 人设分条：第一条与流式文本相同时，第二条不能被吞", async () => {
  const f = fixture({
    rejectDuplicateEdit: true,
    config: { systemPrompt: "自定义人设。", systemPromptIsDefault: false },
    deltas: ["第一句好。", "\n第二句也好。"],
  });
  await f.handler(f.event("说两句", { sender: "333" }));
  const placeholder = f.sends[0];
  assert.equal(f.sentState.get(placeholder.id), "第一句好。");
  assert.ok(
    f.sends.slice(1).some((m) => m.message === "第二句也好。"),
    "分条的第二句必须发出，不能因第一处编辑报错而整段中断",
  );
});

test("K062-09 迟到的流式编辑在最终答案之后落定，占位最终仍是完整答案", async () => {
  let releaseFirstEdit;
  const gate = new Promise((r) => {
    releaseFirstEdit = r;
  });
  const f = fixture({
    deltas: ["部分", "加最终"],
    editHook: async (peer, payload, state, callIndex) => {
      if (callIndex === 1) await gate; // 第一次流式编辑被网络层挂起，迟到落定
      state.set(payload.message, payload.text);
      return { id: payload.message };
    },
  });
  await f.handler(f.event("你好", { sender: "333" }));
  const placeholder = f.sends[0];
  assert.equal(f.sentState.get(placeholder.id), "部分加最终", "最终答案先落定");
  releaseFirstEdit(); // 迟到的旧编辑此刻才落地，会先把占位覆盖回「部分」
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    f.sentState.get(placeholder.id),
    "部分加最终",
    "迟到编辑落定后必须被代次纠正回最终答案，不能停在部分文本",
  );
});

// ================= K062-12：记事本整理版本戳 =================

test("K062-12 后台整理期间清空记事本，整理结果被丢弃、不会把旧事实恢复", async () => {
  let releaseConsolidation;
  const gate = new Promise((r) => {
    releaseConsolidation = r;
  });
  let consolidationStarted = false;
  const gen = (text) =>
    (async function* () {
      yield { choices: [{ delta: { content: text } }] };
    })();
  const f = fixture({
    model: async (params) => {
      const sys = params.messages?.[0]?.content || "";
      if (sys.includes("记事本整理助手")) {
        consolidationStarted = true;
        await gate; // 整理请求挂起，模拟慢模型
        return gen("- 旧事实甲\n- 旧事实乙");
      }
      if (sys.includes("观察助手")) return gen("保留");
      return gen("普通回答。");
    },
  });
  f.notebook.addFacts("111", ["旧事实甲", "旧事实乙"]);
  // 聊满 8 轮触发后台整理
  for (let i = 1; i <= 8; i++) {
    await f.handler(f.event(`问题${i}`));
  }
  for (let i = 0; i < 100 && !consolidationStarted; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(consolidationStarted, "第 8 轮后应已触发后台整理");
  // 整理还在等模型返回时，号主清空记事本
  await f.handler(f.event("/ai 清空记事本"));
  assert.deepEqual(f.notebook.facts("111"), []);
  releaseConsolidation();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.notebook.facts("111"), [], "整理结果基于旧快照，必须丢弃，不能把清空的内容恢复");
  assert.ok(
    f.logger.logs.some((l) => l.text.includes("本次整理结果已丢弃")),
    "应记录丢弃日志",
  );
  assert.ok(
    !f.logger.logs.some((l) => l.text.startsWith("记事本已自动整理")),
    "不能出现已回写的整理日志",
  );
});

test("K062-01 对照：未过期的换key 待办照常保存 key，不进模型不进记录", async () => {
  const group = "-100777";
  const f = fixture({ config: { recordGroups: [group] } });
  await f.handler(f.event("/ai 换key", { group: true, chat: group }));
  await f.handler(f.event("1", { group: true, chat: group }));
  const credential = "FAKE-CREDENTIAL-ON-TIME";
  await f.handler(f.event(credential, { group: true, chat: group }));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.equal(saved.providerOverrides.default.apiKey, credential);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.records.recent(group, 10).length, 0);
  assert.ok(!f.sends.some((m) => m.message.includes(credential)));
});
