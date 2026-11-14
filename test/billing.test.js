// billing.js 单元测试：余额格式化是纯逻辑，重点覆盖额度/不限额/数据缺失三种情况。
import test from "node:test";
import assert from "node:assert/strict";
import { formatBalance } from "../src/billing.js";

test("普通额度：总额减本月已用（美分换算）", () => {
  const s = formatBalance({ hard_limit_usd: 20 }, { total_usage: 250 });
  assert.equal(s, "$17.50（总额 $20.00，本月已用 $2.50）");
});

test("超大额度视为不限额", () => {
  const s = formatBalance({ hard_limit_usd: 100000000 }, { total_usage: 12345 });
  assert.match(s, /^不限额（本月已用 \$123\.45）$/);
});

test("usage 缺失时已用按 0 算", () => {
  const s = formatBalance({ hard_limit_usd: 5 }, null);
  assert.equal(s, "$5.00（总额 $5.00，本月已用 $0.00）");
});

test("subscription 无效返回 null", () => {
  assert.equal(formatBalance(null, { total_usage: 1 }), null);
  assert.equal(formatBalance({}, null), null);
  assert.equal(formatBalance({ hard_limit_usd: "x" }, null), null);
});
