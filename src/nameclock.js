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
 * 拼名字时钟的显示名：名在前；有姓氏时是「姓氏 HH:MM」，没姓氏时姓氏位只有时间。
 * 号主用 /ai 改名 设了 customName 后，时钟用它打头替代 .env 的 NAME_PREFIX。
 * @returns {{firstName: string, lastName: string}}
 */
export function composeClockName(firstName, lastName, hhmm) {
  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  return { firstName: first, lastName: last ? `${last} ${hhmm}` : hhmm };
}

/**
 * 启动名字时钟。返回停止函数。
 * @param {object} client GramJS 客户端
 * @param {object} options { prefix, firstName, lastName, timezone, logger }
 *   firstName/lastName 给了就优先用（号主改名设的 customName），否则退回 prefix。
 */
export function startNameClock(client, options) {
  const { timezone, logger } = options;
  const firstName = String(options.firstName || options.prefix || "").trim();
  const lastName = String(options.lastName || "").trim();
  let lastShown = "";
  let stopped = false;

  async function update() {
    if (stopped) return;
    const hhmm = currentHHMM(timezone);
    if (hhmm === lastShown) return;
    const shown = composeClockName(firstName, lastName, hhmm);
    try {
      await client.invoke(
        new Api.account.UpdateProfile({ firstName: shown.firstName, lastName: shown.lastName }),
      );
      lastShown = hhmm;
      logger.info(`已更新显示名：${shown.firstName} ${shown.lastName}`);
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
