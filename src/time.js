// 当前时间段：拼进系统提示，让模型知道「现在」是什么时候。
// 没有这一段时，模型对「现在几点了 / 今天几号」只能瞎编或推说不知道。
// 纯函数（可注入 Date），无外部依赖，方便单元测试。

/**
* 生成一行当前时间说明，格式如：
* 2026年11月15日 星期六 12:55（Asia/Shanghai）。有人问现在几点、今天几号、星期几时，直接按这个回答，不要说你不知道。
*
* @param {string} timezone IANA 时区名（如 Asia/Shanghai），缺省按 Asia/Shanghai
* @param {Date} [date] 时刻，默认当前时间（测试可注入固定值）
* @returns {string}
*/
export function formatNowLine(timezone, date = new Date()) {
const tz = typeof timezone === "string" && timezone.trim()? timezone.trim(): "Asia/Shanghai";
const parts = new Intl.DateTimeFormat("zh-CN", {
timeZone: tz,
year: "numeric",
month: "numeric",
day: "numeric",
weekday: "long",
hour: "2-digit",
minute: "2-digit",
hourCycle: "h23",
}).formatToParts(date);
const get = (type) => {
const p = parts.find((x) => x.type === type);
return p? p.value: "";
};
return (
`${get("year")}年${get("month")}月${get("day")}日 ${get("weekday")} ` +
`${get("hour")}:${get("minute")}（${tz}）。` +
"有人问现在几点、今天几号、星期几时，直接按这个回答，不要说你不知道。"
);
}
