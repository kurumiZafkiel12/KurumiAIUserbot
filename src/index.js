// 入口：组装配置、日志、提供方池与消息处理，连接 Telegram 并开始监听。

import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { ProviderPool } from "./providers.js";
import { ConversationStore } from "./context.js";
import { Notebook } from "./notebook.js";
import { UserProfiles } from "./profiles.js";
import { RuntimeState } from "./state.js";
import { UsageStats } from "./usagestats.js";
import { GroupRecords } from "./records.js";
import { createHandler } from "./handlers.js";
import { startNameClock } from "./nameclock.js";
import { ToolStore, startReminderScheduler } from "./toolstore.js";

const SESSION_PATH = path.resolve(".ai-session");

async function main() {
  const logger = createLogger();
  const config = loadConfig();

  if (!fs.existsSync(SESSION_PATH)) {
    logger.error("还没有登录会话文件 .ai-session。请先运行 npm run login 完成首次登录。");
    process.exit(1);
  }
  const sessionString = fs.readFileSync(SESSION_PATH, "utf-8").trim();

  const client = new TelegramClient(new StringSession(sessionString), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  if (!(await client.checkAuthorization())) {
    logger.error("会话已失效（可能被 Telegram 注销或在别处重新登录）。请删掉 .ai-session 后重新运行 npm run login。");
    process.exit(1);
  }

  const me = await client.getMe();
  const username = me.username || config.myUsername;
  logger.info(`登录成功：@${username}（ID ${me.id}），开始监听消息...`);
  if (config.myUsername && config.myUsername !== username) {
    logger.warn(`.env 的 MY_USERNAME（${config.myUsername}）与账号实际用户名（${username}）不一致，提及触发可能失灵，请改成实际用户名。`);
  }
  const effectiveConfig = { ...config, myUsername: username };

  // 名字时钟：号主用 /ai 改名 设了 customName 时用它打头替代 NAME_PREFIX。
  // 配置重载时要重启时钟（新名字立即生效），所以做成可反复调用的 applyNameClock。
  let stopClock = null;
  function applyNameClock(cfg) {
    if (stopClock) {
      stopClock();
      stopClock = null;
    }
    if (!cfg.nameClock) return;
    stopClock = startNameClock(client, {
      firstName: (cfg.customName && cfg.customName.first) || cfg.namePrefix,
      timezone: cfg.timezone,
      logger,
    });
  }

  // 可重载运行时：config 与 pool 放在可替换的盒子里。号主命令改完 config.json 后
  // 调 reloadRuntime()，这里重新 loadConfig 并重建提供方池，handlers 换上新引用，
  // 改动立即生效不用重启（记事本后台整理等用 pool 的地方走的也是 handlers 内的引用）。
  const runtime = {
    config: effectiveConfig,
    pool: new ProviderPool(effectiveConfig.providers, logger),
  };
  function reloadRuntime() {
    const fresh = loadConfig();
    const eff = { ...fresh, myUsername: username };
    const oldPool = runtime.pool;
    runtime.config = eff;
    runtime.pool = new ProviderPool(eff.providers, logger);
    // 继承旧池的今日用量与失败冷却：重载不能把每日额度清零（审计 K062-02，
    // 否则普通用户在群里换个音色就能把额度刷回来）。usageStats 是另一套
    // 落盘的 Token 统计，不在这里动。
    runtime.pool.inheritStateFrom(oldPool);
    applyNameClock(eff);
    logger.info("配置已重载（提供方池已重建，改动立即生效）");
    return { config: runtime.config, pool: runtime.pool };
  }

  const store = new ConversationStore(effectiveConfig.contextSize);
  // 记事本与用户档案落盘在运行目录，重启不丢；botNames 让记事本过滤「以机器人为主语」的条目。
  const notebook = new Notebook(path.resolve("facts.json"), {
    botNames: [effectiveConfig.namePrefix, username],
  });
  // 用户记事本：按用户 ID 记的长期事实（userfacts.json），跨所有群与私聊通用。
  const userNotebook = new Notebook(path.resolve("userfacts.json"), {
    botNames: [effectiveConfig.namePrefix, username],
  });
  const profiles = new UserProfiles(path.resolve("profiles.json"));
  // 运行时状态（全局暂停开关）落盘在 state.json：重启后保持关闭，直到创建者发 /ai 开启。
  const state = new RuntimeState(path.resolve("state.json"));
  if (state.isPaused()) {
    logger.warn("当前处于全局关闭状态（state.json 记录了 paused），只响应号主命令；发 /ai 开启 恢复回复。");
  }
  // Token 用量统计落盘在 usage.json：按天按模型累计，跨天归零。
  const usageStats = new UsageStats(path.resolve("usage.json"));
  // 群聊天记录落盘在 records.json：开启记录的群的消息按群环形保存。
  const records = new GroupRecords(path.resolve("records.json"));
  // 工具状态落盘在 reminders.json：定时提醒与待办清单，重启不丢。
  const toolStore = new ToolStore(path.resolve("reminders.json"));
  const handler = createHandler({
    client,
    config: runtime.config,
    pool: runtime.pool,
    getConfig: () => runtime.config,
    getPool: () => runtime.pool,
    reloadRuntime,
    store,
    notebook,
    userNotebook,
    profiles,
    state,
    usageStats,
    records,
    toolStore,
    logger,
    startedAt: Date.now(),
    selfId: String(me.id),
  });

  // 关键点：必须用 NewMessage 规范事件注册处理函数，不能直接裸挂 addEventHandler 回调。
  // Telegram 私聊消息走的是 UpdateShortMessage 简版更新，裸回调拿到的 event.message
  // 不是完整的消息对象（没有 senderId / chatId / 正文），私聊会永远没反应；
  // NewMessage 构建器会把这类更新统一转成标准 Message，私聊和群聊才能走同一套逻辑。
  client.addEventHandler(handler, new NewMessage({}));

  applyNameClock(effectiveConfig);

  // 定时提醒调度：到点往原会话发提醒消息（进程生命周期内常驻）。
  startReminderScheduler(client, toolStore, logger);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在断开连接...`);
    try {
      if (stopClock) stopClock();
      await client.disconnect();
    } catch (err) {
      logger.error(`断开连接时出错：${err.message}`);
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`启动失败：${err.message}`);
  process.exit(1);
});
