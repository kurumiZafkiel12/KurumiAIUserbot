// 当前时间段的单元测试：node --test 运行，不依赖 telegram / openai 包。

import test from "node:test";
import assert from "node:assert/strict";
import { formatNowLine} from "../src/time.js";

// 固定时刻：2025-11-15T04:55:00Z。Asia/Shanghai（UTC+8）是当天 12:55，星期六。
const INSTANT = new Date(Date.UTC(2025, 10, 15, 4, 55, 0));

test("上海时区：日期、星期、时刻与格式都对", () => {
assert.equal(
formatNowLine("Asia/Shanghai", INSTANT),
"2025年11月15日 星期六 12:55（Asia/Shanghai）。有人问现在几点、今天几号、星期几时，直接按这个回答，不要说你不知道。",
);
});

test("换时区会换日期与星期（纽约还是前一天周五深夜）", () => {
assert.equal(
formatNowLine("America/New_York", INSTANT),
"2025年11月14日 星期五 23:55（America/New_York）。有人问现在几点、今天几号、星期几时，直接按这个回答，不要说你不知道。",
);
});

test("时区缺省或为空时回退到 Asia/Shanghai", () => {
assert.ok(formatNowLine(undefined, INSTANT).startsWith("2025年11月15日 星期六 12:55（Asia/Shanghai）"));
assert.ok(formatNowLine("", INSTANT).startsWith("2025年11月15日 星期六 12:55（Asia/Shanghai）"));
});

test("星期由 Intl 真实历法得出：2026-11-15 是星期日", () => {
// 2026-11-15T04:55:00Z，上海 12:55；2026-11-15 实际是星期日，不是示例里随手写的星期六。
const line = formatNowLine("Asia/Shanghai", new Date(Date.UTC(2026, 10, 15, 4, 55, 0)));
assert.ok(line.startsWith("2026年11月15日 星期日 12:55（Asia/Shanghai）"));
});
