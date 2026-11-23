// handlers 主链路回归测试（审计 K062 系列）：真实 createHandler/ProviderPool +
// 假 Telegram/模型。必须在 import 源码前把 KURUMI_ROOT_DIR 指到临时目录——
// config.json 锚定项目根目录，号主命令落盘不能污染仓库根目录。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-handlers-test-"));
process.env.KURUMI_ROOT_DIR = tmpRoot;
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
      const m = { id: ++messageId, message: payload.message, peerId: peer, replyTo: payload.replyTo, formattingEntities: payload.formattingEntities };
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
  const userNotebook = new Notebook(null);
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
    userNotebook,
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

  return { handler, event, pool, getPool: () => currentPool, config, store, pending, records, notebook, userNotebook, profiles, state, sends, edits, files, sentState, modelCalls, logger, recordsPath, notebookPath };
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

// ================= v0.7.0：按用户 ID 的全局记忆 =================

test("v0.7.0 查看印象：称呼、印象与用户记事本一并列出", async () => {
  const f = fixture();
  f.profiles.setCallName("999", "阿紫");
  f.profiles.setImpression("999", "爱聊游戏，语气爽快");
  f.userNotebook.addFacts("999", ["阿紫：自称很有钱"]);
  await f.handler(f.event("/ai 查看印象 999"));
  const reply = f.sends.map((s) => s.message).join("\n");
  assert.match(reply, /阿紫/);
  assert.match(reply, /爱聊游戏，语气爽快/);
  assert.match(reply, /自称很有钱/);
  assert.match(reply, /跨会话通用/);
});

test("v0.7.0 印象/称呼设置命令：写完立刻能查到", async () => {
  const f = fixture();
  await f.handler(f.event("/ai 印象 999 夜猫子，爱聊 VPS"));
  assert.equal(f.profiles.impression("999"), "夜猫子，爱聊 VPS");
  await f.handler(f.event("/ai 称呼 999 小紫"));
  assert.equal(f.profiles.callName("999"), "小紫");
  await f.handler(f.event("/ai 查看印象 999"));
  const reply = f.sends.map((s) => s.message).join("\n");
  assert.match(reply, /夜猫子，爱聊 VPS/);
  assert.match(reply, /小紫/);
});

test("v0.7.0 用户记事本跨群注入：别的群里也带着这个人的事实", async () => {
  const f = fixture();
  f.userNotebook.addFacts("999", ["测试用户：自称很有钱"]);
  await f.handler(f.event("@mybot 我富不富", { sender: "999", group: true, chat: "-100888" }));
  assert.ok(f.modelCalls.length >= 1);
  const system = f.modelCalls[0].messages[0].content;
  assert.match(system, /自称很有钱/);
  assert.match(system, /任何群、任何私聊里都通用/);
});

test("v0.7.0 忘掉用户/清空用户记忆：按 ID 管理用户事实", async () => {
  const f = fixture();
  f.userNotebook.addFacts("999", ["事实一", "事实二"]);
  await f.handler(f.event("/ai 忘掉用户 999 1"));
  assert.deepEqual(f.userNotebook.facts("999"), ["事实二"]);
  await f.handler(f.event("/ai 清空用户记忆 999"));
  assert.deepEqual(f.userNotebook.facts("999"), []);
});

test("v0.7.0 后台整理双段输出：会话事实与用户事实分别落盘", async () => {
  const f = fixture({
    answer: "【会话记事本】\n- 群里最近在聊游戏\n【用户记事本】\n- 测试用户：自称很有钱",
  });
  for (let i = 0; i < 8; i++) {
    await f.handler(f.event("@mybot 在吗", { sender: "999", group: true, id: 100 + i }));
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(f.notebook.facts("-100777").some((x) => x.includes("聊游戏")), "会话记事本应写入会话段");
  assert.ok(f.userNotebook.facts("999").some((x) => x.includes("很有钱")), "用户记事本应写入用户段");
});

// ================= v0.7.1：超长回复折叠为可展开引用 =================

test("v0.7.1 号主帮助是超长文：整段带 collapsed 引用实体发送", async () => {
  const f = fixture();
  await f.handler(f.event("/ai 帮助"));
  const help = f.sends.find((s) => s.message.includes("【记事本】"));
  assert.ok(help, "应发出号主帮助");
  assert.ok(help.message.length >= 1000);
  const ent = (help.formattingEntities || [])[0];
  assert.ok(ent, "超长帮助应带引用实体");
  assert.equal(ent.className, "MessageEntityBlockquote");
  assert.equal(ent.collapsed, true);
  assert.equal(ent.offset, 0);
  assert.equal(ent.length, help.message.length);
});

test("v0.7.1 短回复不带引用实体；超长单条答案的最终编辑带引用实体", async () => {
  const f = fixture();
  await f.handler(f.event("/ai 记事本"));
  const short = f.sends[f.sends.length - 1];
  assert.equal(short.formattingEntities, undefined);

  const g = fixture({ answer: "答".repeat(1500) });
  await g.handler(g.event("讲个长故事", { sender: "999" }));
  const quoted = g.edits.filter((e) => (e.formattingEntities || []).some((x) => x.collapsed === true));
  assert.ok(quoted.length >= 1, "超长答案的最终编辑应带 collapsed 引用实体");
});

// ================= v0.7.2：访客名单（私聊门禁放行） =================

test("v0.7.2 访客：门禁 admins 时先拦、加访客后放行、删访客再拦", async () => {
  const f = fixture({ config: { privateChat: "admins" } });
  await f.handler(f.event("你好", { sender: "999" }));
  assert.equal(f.modelCalls.length, 0, "未加访客前私聊应被门禁拦下");
  await f.handler(f.event("/ai 加访客 999"));
  assert.ok(f.sends.some((s) => s.message.includes("已添加访客 999")));
  await f.handler(f.event("你好", { sender: "999" }));
  assert.equal(f.modelCalls.length, 1, "加访客后私聊应放行到模型");
  await f.handler(f.event("/ai 访客列表"));
  assert.ok(f.sends.some((s) => s.message.includes("访客名单") && s.message.includes("999")));
  await f.handler(f.event("/ai 删访客 999"));
  const calls = f.modelCalls.length;
  await f.handler(f.event("你好", { sender: "999" }));
  assert.equal(f.modelCalls.length, calls, "删访客后私聊应再次被拦");
});

// ================= v0.8.2：文本工具调用抢救 =================

test("v0.8.2 抢救：普通聊天里模型把工具调用写成 <tool_call> 文本时，真执行并重答、不发标记", async () => {
  const MARKUP = '<tool_call>{"name": "flip_coin", "arguments": {"times": 1}}</tool_call>';
  const f = fixture({
    model: (params, idx) => {
      if (params.stream) {
        const text = idx === 1 ? MARKUP : "抛出来了，结果是正面。";
        return (async function* () {
          yield { choices: [{ delta: { content: text } }] };
        })();
      }
      return { choices: [{ message: { content: "非流式回答" } }] };
    },
  });
  await f.handler(f.event("@mybot 随便聊聊", { group: true, chat: "-100777", sender: "333" }));
  assert.equal(f.modelCalls.length, 2, "应有原回答 + 拿工具结果重答两次调用");
  const followUp = JSON.stringify(f.modelCalls[1].messages);
  assert.ok(followUp.includes("【工具执行结果】") && followUp.includes("抛硬币 1 次"), "重答应带上真实工具结果");
  const visible = [...f.sentState.values()].join("\n") + f.sends.map((m) => m.message).join("\n");
  assert.ok(!visible.includes("<tool_call>"), "发给用户的文本绝不能含 <tool_call> 标记");
  assert.ok(visible.includes("抛出来了"), "最终应发重答后的自然回答");
});

// ================= v0.8.3：只 @ 不说话不回罐头句 =================

test("v0.8.3 只 @ 不说话：走模型用人设接话，不发固定提示句", async () => {
  const f = fixture({ answer: "在呢，怎么了" });
  await f.handler(f.event("@mybot", { group: true, chat: "-100777", sender: "333" }));
  assert.equal(f.modelCalls.length, 1, "光 @ 一声也应走模型");
  const visible = [...f.sentState.values()].join("\n") + f.sends.map((m) => m.message).join("\n");
  assert.ok(!visible.includes("把问题和"), "绝不能再发脚本味的固定提示句");
  assert.ok(visible.includes("在呢"), "应发模型的人设回答");
});

// ================= v0.8.6：匿名发言（马甲用户）不回复修复 =================

test("v0.8.6 匿名发言：群里无 senderId 的消息回复机器人时应触发回答", async () => {
  const f = fixture();
  const botMsg = { id: 5, senderId: "9999", message: "2 呀" };
  await f.handler(f.event("1-2-3+4/5-6=?", { group: true, sender: null, reply: botMsg }));
  assert.ok(f.modelCalls.length >= 1, "匿名者回复机器人消息应进模型");
  assert.ok(f.sends.length >= 1 || f.edits.length >= 1, "应发出回答");
});

test("v0.8.6 匿名发言：私聊无 senderId 仍丢弃（私聊没有匿名）", async () => {
  const f = fixture();
  await f.handler(f.event("你好", { sender: null }));
  assert.equal(f.modelCalls.length, 0);
});

test("v0.8.7 匿名发言按签名区分：不同签名各一份上下文，无签名不串到签名名下", async () => {
  const f = fixture();
  const botMsg = { id: 5, senderId: "9999", message: "2 呀" };
  const ev1 = f.event("问题一", { group: true, sender: null, reply: botMsg });
  ev1.message.postAuthor = "姥爷";
  await f.handler(ev1);
  const ev2 = f.event("问题二", { group: true, sender: null, reply: botMsg });
  ev2.message.postAuthor = "另一位管理";
  await f.handler(ev2);
  assert.ok(f.store.get("-100777", "anon:-100777:姥爷").length >= 1, "签名「姥爷」应有独立上下文");
  assert.ok(f.store.get("-100777", "anon:-100777:另一位管理").length >= 1, "另一签名应有独立上下文");
  assert.equal(f.store.get("-100777", "anon:-100777").length, 0, "带签名的不应落进无签名共用身份");
});

// ================= v0.9.4：换模型列出全部模型再选 =================

test("v0.9.4 换模型：选 API 后列出全部模型，回序号写入 overrides 并设默认", async () => {
  const f = fixture();
  f.pool.entries[0].client.models.list = async () => ({
    data: [{ id: "mock-model" }, { id: "alt-model" }, { id: "third-model" }],
  });
  await f.handler(f.event("/ai 换模型"));
  await f.handler(f.event("1"));
  const listReply = f.sends.map((m) => m.message).join("\n");
  assert.match(listReply, /alt-model/);
  assert.match(listReply, /third-model/);
  assert.match(listReply, /（当前）/);
  await f.handler(f.event("2"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.equal(saved.providerOverrides.default.model, "alt-model");
  assert.equal(saved.defaultProvider, "default");
  const all = f.sends.map((m) => m.message).join("\n");
  assert.match(all, /已把「default」的模型换成 alt-model/);
  assert.equal(f.modelCalls.length, 0);
});

test("v0.9.4 换模型：模型列表拉不到时，直接发模型名全文也能换", async () => {
  const f = fixture();
  f.pool.entries[0].client.models.list = async () => {
    throw new Error("models endpoint not supported");
  };
  await f.handler(f.event("/ai 换模型"));
  await f.handler(f.event("1"));
  const prompt = f.sends.map((m) => m.message).join("\n");
  assert.match(prompt, /直接发模型名全文就能换/);
  await f.handler(f.event("typed-model"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.equal(saved.providerOverrides.default.model, "typed-model");
});

test("v0.9.20 加生图api 分步添加：四步走完落盘为生图提供方，key 不回显不进模型", async () => {
  const f = fixture();
  await f.handler(f.event("/ai 加生图api"));
  await f.handler(f.event("imgone"));
  await f.handler(f.event("https://img.example.com/v1"));
  await f.handler(f.event("FAKE-IMAGE-KEY"));
  await f.handler(f.event("gpt-image-1"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  const added = (saved.customProviders || []).find((p) => p.name === "imgone");
  assert.ok(added, "应保存新提供方");
  assert.equal(added.image, true);
  assert.equal(added.model, "gpt-image-1");
  assert.equal(added.apiKey, "FAKE-IMAGE-KEY");
  assert.ok(!f.sends.some((m) => m.message.includes("FAKE-IMAGE-KEY")), "key 不得回显");
  assert.equal(f.modelCalls.length, 0);
});

test("v0.9.20 加生图api 一步式仍可用；分步中途重名被拒", async () => {
  const f = fixture();
  await f.handler(f.event("/ai 加生图api one https://a.example.com/v1 FAKE-K1 model-x"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.ok((saved.customProviders || []).some((p) => p.name === "one" && p.image === true));
  const f2 = fixture({
    config: {
      customProviders: [{ name: "one", baseURL: "https://a.example.com/v1", apiKey: "FAKE-K1", model: "model-x", image: true }],
    },
  });
  await f2.handler(f2.event("/ai 加生图api"));
  await f2.handler(f2.event("one"));
  const reply = f2.sends.map((s) => s.message).join("\n");
  assert.match(reply, /已经有了/);
});


test("v0.9.21 换模型支持生图提供方：列表里挑，只写 overrides 不动聊天默认", async () => {
  const f = fixture({
    config: {
      providers: [
        { name: "default", model: "mock-model", baseURL: "https://offline.invalid/v1", apiKey: "x", dailyLimit: 0 },
        { name: "imgone", model: "img-a", baseURL: "https://img.invalid/v1", apiKey: "y", dailyLimit: 0, image: true },
      ],
    },
  });
  f.pool.entries[1].client.models.list = async () => ({ data: [{ id: "img-a" }, { id: "img-b" }] });
  await f.handler(f.event("/ai 换模型"));
  await f.handler(f.event("2"));
  const listReply = f.sends.map((m) => m.message).join("\n");
  assert.match(listReply, /img-b/);
  assert.match(listReply, /（当前）/);
  await f.handler(f.event("2"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.equal(saved.providerOverrides.imgone.model, "img-b");
  assert.notEqual(saved.defaultProvider, "imgone");
  const all = f.sends.map((m) => m.message).join("\n");
  assert.match(all, /已把生图提供方「imgone」的模型换成 img-b/);
  assert.equal(f.modelCalls.length, 0);
});

test("v0.9.22 生图 502 自动重试一次后成功，占位符是（生图中...）", async () => {
  let calls = 0;
  const png = Buffer.alloc(600, 7).toString("base64");
  const f = fixture({
    config: {
      providers: [
        { name: "default", model: "mock-model", baseURL: "https://offline.invalid/v1", apiKey: "x", dailyLimit: 0 },
        { name: "imgone", model: "img-a", baseURL: "https://img.invalid/v1", apiKey: "y", dailyLimit: 0, image: true },
      ],
    },
    deps: {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png }] }) };
      },
    },
  });
  await f.handler(f.event("画一张 猫"));
  assert.equal(calls, 2);
  assert.equal(f.files.length, 1);
  assert.ok(f.sends.some((m) => m.message === "（生图中...）"));
});

test("v0.9.23 模型判定生图：正则没命中的说法经 generate_image 工具出图", async () => {
  const png = Buffer.alloc(600, 7).toString("base64");
  const f = fixture({
    config: {
      providers: [
        { name: "default", model: "mock-model", baseURL: "https://offline.invalid/v1", apiKey: "x", dailyLimit: 0 },
        { name: "imgone", model: "img-a", baseURL: "https://img.invalid/v1", apiKey: "y", dailyLimit: 0, image: true },
      ],
    },
    deps: {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: png }] }) }),
    },
    model: (params, n) =>
      n === 1
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "东方明珠夜景照片" }) } }] } }] }
        : { choices: [{ message: { content: "画好了。" } }] },
  });
  // 「照片」离动词太远（超出正则名词窗口），正则快线不命中，只能靠模型判定走工具。
  await f.handler(f.event("帮我生成一张东方明珠的夜景照片"));
  assert.ok(f.modelCalls.length >= 1, "应先经过模型判定");
  assert.equal(f.files.length, 1);
  // 工具线复用聊天占位：只发一条「（思考中...）」，生图时把同一条改成「（生图中...）」，
  // 不另发第二条占位；最终回复「画好了。」也编辑在同一条上，且排在生图之后（生完图再回）。
  const ph = f.sends.find((m) => m.message === "（思考中...）");
  assert.ok(ph, "应先发聊天占位");
  assert.ok(!f.sends.some((m) => m.message === "（生图中...）"), "不应另发第二条生图占位");
  const genIdx = f.edits.findIndex((e) => e.message === ph.id && e.text === "（生图中...）");
  const ansIdx = f.edits.findIndex((e) => e.message === ph.id && e.text === "画好了。");
  assert.ok(genIdx >= 0, "生图时应把聊天占位改成（生图中...）");
  assert.ok(ansIdx > genIdx, "最终回复应落在同一条占位上、且在生图之后");
});

test("v0.9.24 系统提示含消息核实段：未证实不确认不编数字、旧知识不否定新事", async () => {
  const f = fixture();
  await f.handler(f.event("随便聊聊今天过得怎么样"));
  const sys = String(f.modelCalls[0]?.messages?.[0]?.content || "");
  assert.ok(sys.includes("【消息核实】"), "系统提示须含消息核实段");
  assert.ok(sys.includes("不许编造涨幅、金额、时间、人数这类具体数字"), "须含不编数字");
  assert.ok(sys.includes("不许断言没这回事"), "须含不凭旧知识否定");
});

test("v0.9.25 分条尾条行数爆表时折叠：短条不折，尾条带 collapsed 引用实体", async () => {
  const story = Array.from({ length: 14 }, (_, i) => `第${i + 1}行小故事`).join("\n");
  const f = fixture({
    config: { systemPrompt: "自定义人设。", systemPromptIsDefault: false },
    answer: story,
  });
  await f.handler(f.event("讲个故事", { sender: "999" }));
  const tail = f.sends.find((s) => s.message.includes("第5行小故事"));
  assert.ok(tail, "尾条应发出");
  assert.ok(tail.message.split("\n").length > 8, "尾条应合并了多行");
  const ent = (tail.formattingEntities || [])[0];
  assert.ok(ent && ent.className === "MessageEntityBlockquote" && ent.collapsed === true, "尾条应折叠");
  const head = f.sends.find((s) => s.message === "第2行小故事");
  assert.ok(head, "前面的短条应发出");
  assert.equal(head.formattingEntities, undefined, "单行短条不折叠");
});

test("v0.9.25 单条多行短文也按行数折叠，行数不多的不折", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `一行${i}`).join("\n");
  const f = fixture({ answer: many });
  await f.handler(f.event("说点什么", { sender: "999" }));
  const quoted = f.edits.filter((e) => (e.formattingEntities || []).some((x) => x.collapsed === true));
  assert.ok(quoted.length >= 1, "10 行短文（字数不到 1000）应按行数折叠");
  const few = fixture({ answer: "一共三行\n第二行\n第三行" });
  await few.handler(few.event("说点什么", { sender: "999" }));
  const quoted2 = few.edits.filter((e) => (e.formattingEntities || []).some((x) => x.collapsed === true));
  assert.equal(quoted2.length, 0, "3 行不折叠");
});

test("0.0.3 群里分条最多 3 条且每条都带引用，私聊仍 5 条", async () => {
  const story = Array.from({ length: 6 }, (_, i) => `第${i + 1}行小故事`).join("\n");
  const g = fixture({
    config: { systemPrompt: "自定义人设。", systemPromptIsDefault: false },
    answer: story,
  });
  await g.handler(g.event("@mybot 讲个故事", { sender: "999", group: true }));
  const gParts = g.sends.filter((s) => s.message.includes("小故事"));
  assert.equal(gParts.length, 2, "群里补发 2 条（加占位编辑共 3 条封顶）");
  assert.ok(gParts.every((s) => s.replyTo === 10), "后续条带引用（v0.0.3 恢复）");
  const gTail = gParts.find((s) => s.message.includes("第3行小故事"));
  assert.ok(gTail && gTail.message.split("\n").length === 4, "群尾条应并入剩余 4 行");
  const d = fixture({
    config: { systemPrompt: "自定义人设。", systemPromptIsDefault: false },
    answer: story,
  });
  await d.handler(d.event("讲个故事", { sender: "999" }));
  const dParts = d.sends.filter((s) => s.message.includes("小故事"));
  assert.equal(dParts.length, 4, "私聊补发 4 条（加占位编辑共 5 条）");
  assert.ok(dParts.every((s) => s.replyTo === 10), "私聊后续条同样带引用");
});

test("0.0.3 群聊判定看会话 ID：peer 无群信号时负数 chatId 也封顶 3 条", async () => {
  const story = Array.from({ length: 6 }, (_, i) => `第${i + 1}行小故事`).join("\n");
  const g = fixture({
    config: { systemPrompt: "自定义人设。", systemPromptIsDefault: false },
    answer: story,
  });
  const ev = g.event("@mybot 讲个故事", { sender: "999", group: true });
  ev.message.peerId = {}; // 模拟生产里 peer 结构判不出群的情况，只剩 chatId 是负数
  await g.handler(ev);
  const gParts = g.sends.filter((s) => s.message.includes("小故事"));
  assert.equal(gParts.length, 2, "靠 chatId 判定群聊，补发 2 条封顶 3 条");
});

test("0.0.6 加识图：选 API 后列出它的模型并标记可识图，回序号存池（权重7）且实测通过", async () => {
  const f = fixture({ answer: "红色" });
  f.pool.entries[0].client.models.list = async () => ({
    data: [{ id: "mock-model" }, { id: "gemini-3-flash-preview" }, { id: "plain-text-model" }],
  });
  await f.handler(f.event("/ai 加识图"));
  await f.handler(f.event("1"));
  const listReply = f.sends.map((m) => m.message).join("\n");
  assert.match(listReply, /gemini-3-flash-preview（可识图）/);
  const plainLine = listReply.split("\n").find((l) => l.includes("plain-text-model"));
  assert.ok(plainLine && !plainLine.includes("可识图"), "纯文本模型不应打可识图标记");
  await f.handler(f.event("2"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.deepEqual(saved.visionPool.default, [{ model: "gemini-3-flash-preview", weight: 7 }]);
  const all = f.sends.map((m) => m.message).join("\n");
  assert.match(all, /实测通过/);
  assert.match(all, /红色/);
  assert.equal(f.modelCalls.length, 1, "实测应真调一次模型");
  const probeContent = f.modelCalls[0].messages[0].content;
  assert.ok(Array.isArray(probeContent) && probeContent.some((p) => p.type === "image_url"), "实测调用应带图");
});

test("0.0.6 加识图：实测失败也存池，但回复明说没通过", async () => {
  const f = fixture({
    model: async () => {
      throw new Error("400 model does not support images");
    },
  });
  await f.handler(f.event("/ai 加识图"));
  await f.handler(f.event("1"));
  await f.handler(f.event("1"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.deepEqual(saved.visionPool.default, [{ model: "mock-model", weight: 7 }]);
  const all = f.sends.map((m) => m.message).join("\n");
  assert.match(all, /实测没通过/);
  assert.match(all, /does not support images/);
});

test("0.0.6 加识图：模型列表拉不到时，手打模型名全文也能加", async () => {
  const f = fixture({ answer: "红色" });
  f.pool.entries[0].client.models.list = async () => {
    throw new Error("not supported");
  };
  await f.handler(f.event("/ai 加识图"));
  await f.handler(f.event("1"));
  const prompt = f.sends.map((m) => m.message).join("\n");
  assert.match(prompt, /直接发识图模型名全文/);
  await f.handler(f.event("typed-vision-model"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
  assert.deepEqual(saved.visionPool.default, [{ model: "typed-vision-model", weight: 7 }]);
  const all = f.sends.map((m) => m.message).join("\n");
  assert.match(all, /实测通过/);
});

test("0.0.5 机械刷量改模型回绝：数到10000 照常调模型，但系统提示注入不真数指令", async () => {
  const f = fixture({ answer: "才不要，真数要累死鱼了" });
  await f.handler(f.event("@mybot 从1数到10000", { sender: "999", group: true }));
  assert.equal(f.modelCalls.length, 1, "应照常调用模型（回绝的话由模型说，不发罐头）");
  const sys = f.modelCalls[0].messages[0].content;
  assert.ok(sys.includes("机械刷量请求") && sys.includes("10000"), "系统提示应注入刷量回绝指令并带目标数");
  assert.ok(!f.sends.some((s) => s.message.includes("这个就不真数了")), "不应再发 v0.0.4 的写死罐头句");
  const g = fixture({ answer: "1,2,3 一直数到100" });
  await g.handler(g.event("@mybot 数到100", { sender: "999", group: true }));
  assert.equal(g.modelCalls.length, 1, "数到100 应照常走模型");
  assert.ok(!g.modelCalls[0].messages[0].content.includes("机械刷量请求"), "小数目不注入回绝指令");
});

test("0.0.5 重复刷量同样注入指令，中文数字一万也认", async () => {
  const f = fixture({ answer: "好的" });
  await f.handler(f.event("@mybot 把这句话重复500遍", { sender: "999", group: true }));
  assert.equal(f.modelCalls.length, 1, "重复500遍应调模型回绝");
  assert.ok(f.modelCalls[0].messages[0].content.includes("重复 500 遍"), "系统提示应带重复次数");
  const g = fixture({ answer: "好的" });
  await g.handler(g.event("@mybot 数到一万", { sender: "999", group: true }));
  assert.ok(g.modelCalls[0].messages[0].content.includes("数到 10000") || g.modelCalls[0].messages[0].content.includes("一直数到 10000"), "中文数字一万应解析成 10000 并注入");
});

test("0.0.4 上下文存储截断：超长回复存入时截到 3000 字加省略号", () => {
  const store = new ConversationStore(20);
  store.push("c1", "u1", "assistant", "长".repeat(5000));
  const got = store.get("c1", "u1")[0];
  assert.equal(got.content.length, 3001, "应截断为 3000 字 + 省略号");
  assert.ok(got.content.endsWith("…"));
  store.push("c1", "u1", "user", "短消息");
  assert.equal(store.get("c1", "u1")[1].content, "短消息", "短消息不截断");
});

test("0.0.2 提供方列表标注类型：聊天/生图/识图人人有份，不标地理区域", async () => {
  const f = fixture({
    config: {
      providers: [
        { name: "default", model: "deepseek-flash", baseURL: "https://api.deepseek.com/v1", apiKey: "x", dailyLimit: 0 },
        { name: "tokennova", model: "gpt-image-2", baseURL: "https://hk.tokennova.cc/v1", apiKey: "y", dailyLimit: 0, image: true },
        { name: "seer", model: "gpt-4o", baseURL: "https://api.example.org/v1", apiKey: "z", dailyLimit: 0 },
      ],
      visionPool: { seer: [{ model: "gpt-4o", weight: 7 }] },
    },
  });
  await f.handler(f.event("/ai 查看api"));
  const list = f.sends.map((m) => m.message).join("\n");
  assert.match(list, /default \| 类型：聊天 \| 模型：deepseek-flash \|/);
  assert.match(list, /tokennova \| 类型：生图 \| 模型：gpt-image-2 \|/);
  assert.match(list, /seer \| 类型：聊天、识图 \| 模型：gpt-4o \|/);
  assert.ok(!list.includes("区域："), "不再标地理区域");
});
