// 显示名时钟：把机器人账号的显示名设为「前缀 HH:MM」（如 GPT 13:45），每分钟刷新一次。
// 只在时间真的变了的时候才调接口，避免无谓请求。

import { Api } from "telegram";

/** 取某个时区当前的 HH:MM 字符串。 */
export function currentHHMM(timezone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(date);
}

/**
 * 启动名字时钟。返回停止函数。
 * @param {object} client GramJS 客户端
 * @param {object} options { prefix, timezone, logger }
 */
export function startNameClock(client, options) {
  const { prefix, timezone, logger } = options;
  let lastName = "";
  let stopped = false;

  async function update() {
    if (stopped) return;
    const hhmm = currentHHMM(timezone);
    if (hhmm === lastName) return;
    try {
      await client.invoke(
        new Api.account.UpdateProfile({ firstName: prefix, lastName: hhmm }),
      );
      lastName = hhmm;
      logger.info(`已更新显示名：${prefix} ${hhmm}`);
    } catch (err) {
      // 改名失败只记录，不影响聊天主流程；下一分钟会再试。
      logger.error(`更新显示名失败：${err.message}`);
    }
  }

  update();
  const timer = setInterval(update, 60_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
