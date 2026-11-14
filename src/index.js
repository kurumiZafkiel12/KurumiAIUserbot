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
import { createHandler } from "./handlers.js";
import { startNameClock } from "./nameclock.js";

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

  const pool = new ProviderPool(effectiveConfig.providers, logger);
  const store = new ConversationStore(effectiveConfig.contextSize);
  // 记事本与用户档案落盘在运行目录，重启不丢；botNames 让记事本过滤「以机器人为主语」的条目。
  const notebook = new Notebook(path.resolve("facts.json"), {
    botNames: [effectiveConfig.namePrefix, username],
  });
  const profiles = new UserProfiles(path.resolve("profiles.json"));
  const handler = createHandler({
    client,
    config: effectiveConfig,
    pool,
    store,
    notebook,
    profiles,
    logger,
    startedAt: Date.now(),
  });

  // 关键点：必须用 NewMessage 规范事件注册处理函数，不能直接裸挂 addEventHandler 回调。
  // Telegram 私聊消息走的是 UpdateShortMessage 简版更新，裸回调拿到的 event.message
  // 不是完整的消息对象（没有 senderId / chatId / 正文），私聊会永远没反应；
  // NewMessage 构建器会把这类更新统一转成标准 Message，私聊和群聊才能走同一套逻辑。
  client.addEventHandler(handler, new NewMessage({}));

  let stopClock = null;
  if (effectiveConfig.nameClock) {
    stopClock = startNameClock(client, {
      prefix: effectiveConfig.namePrefix,
      timezone: effectiveConfig.timezone,
      logger,
    });
  }

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
