// 首次登录：手机号 + 验证码（+ 可选两步验证密码），全程在同一个会话里完成。
// 不需要申请 API 凭证：默认用内置的 Telegram Desktop 公开凭证（config.js），
// .env 里填了 TELEGRAM_API_ID / TELEGRAM_API_HASH 时才用自定义的那套。
// 登录成功后把会话字符串存到 .ai-session，之后 npm start 直接用它连接，不用再输验证码。
//
// 注意：发码和验码必须在同一次运行里完成——中途退出再重来，验证码会失效（PHONE_CODE_EXPIRED）。

import fs from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { loadConfig } from "./config.js";
import { rootPath } from "./rootdir.js";

const SESSION_PATH = rootPath(".ai-session");

function printPhoneWarning() {
  console.log("");
  console.log("========================================================");
  console.log("重要：手机号必须带正确的国家区号！");
  console.log("  中国大陆号码：+86 开头，例如 +8613812345678");
  console.log("  美国/加拿大号码：+1 开头，例如 +13825550137");
  console.log("区号填错，验证码会发到别人的账号上，你永远收不到。");
  console.log("验证码一般不发短信，而是出现在 Telegram 应用内的");
  console.log("“Telegram”官方服务通知对话里，请打开应用查看。");
  console.log("========================================================");
  console.log("");
}

async function main() {
  const config = loadConfig(); // 只用其中的 apiId / apiHash
  if (config.apiCredentialSource === "builtin") {
    console.log("（使用内置 Telegram Desktop 公开凭证登录，不需要申请 API 凭证。）");
  }
  printPhoneWarning();

  const phone = (await input.text("请输入手机号（带 + 和国家区号）: ")).trim();
  if (!phone.startsWith("+") || phone.replace(/\D/g, "").length < 7) {
    console.error("手机号格式不对：应以 + 开头并带国家区号，例如 +8613812345678。请重新运行。");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      const code = await input.text("请输入 Telegram 应用内收到的验证码: ");
      return code.trim();
    },
    password: async () => {
      const pwd = await input.password("如账号开了两步验证，请输入密码（没开直接回车）: ");
      return pwd || "";
    },
    onError: (err) => {
      console.error(`登录出错：${err.message}`);
    },
  });

  const me = await client.getMe();
  const sessionString = client.session.save();
  fs.writeFileSync(SESSION_PATH, sessionString, "utf-8");
  try {
    fs.chmodSync(SESSION_PATH, 0o600);
  } catch {
    // Windows 等平台可能不支持 chmod，忽略即可，但要注意别把该文件外传。
  }

  console.log("");
  console.log(`登录成功：@${me.username || ""}（ID ${me.id}）`);
  console.log(`会话已保存到 ${SESSION_PATH}（这个文件等于账号登录态，千万不要外泄）。`);
  console.log("现在可以运行 npm start 启动机器人。");
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(`登录失败：${err.message}`);
  process.exit(1);
});
