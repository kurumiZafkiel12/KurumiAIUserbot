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

test("formatVendorBalance：DeepSeek 风格余额（CNY 有余额、USD 为 0 只显示 CNY）", async () => {
  const { formatVendorBalance } = await import("../src/billing.js");
  const s = formatVendorBalance({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "4.65", granted_balance: "0.00", topped_up_balance: "4.65" },
      { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
    ],
  });
  assert.equal(s, "¥4.65（充值 4.65 / 赠送 0.00）");
});

test("formatVendorBalance：多币种都有余额时并列，赠送单列", async () => {
  const { formatVendorBalance } = await import("../src/billing.js");
  const s = formatVendorBalance({
    balance_infos: [
      { currency: "CNY", total_balance: "10.00", granted_balance: "10.00", topped_up_balance: "0.00" },
      { currency: "USD", total_balance: "2.5", granted_balance: "0", topped_up_balance: "2.5" },
    ],
  });
  assert.equal(s, "¥10.00（充值 0.00 / 赠送 10.00）；$2.50（充值 2.50 / 赠送 0.00）");
});

test("formatVendorBalance：全为 0 显示第一个币种 0.00；脏数据返回 null", async () => {
  const { formatVendorBalance } = await import("../src/billing.js");
  assert.equal(
    formatVendorBalance({ balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0", topped_up_balance: "0" }] }),
    "¥0.00",
  );
  assert.equal(formatVendorBalance(null), null);
  assert.equal(formatVendorBalance({}), null);
  assert.equal(formatVendorBalance({ balance_infos: [] }), null);
  assert.equal(formatVendorBalance({ balance_infos: "x" }), null);
});

test("fetchBalance：OpenAI 风格 404 时回退 DeepSeek /user/balance", async () => {
  const { fetchBalance } = await import("../src/billing.js");
  const entry = { name: "ds-fallback-test", client: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-test" } };
  const fakeFetch = async (url) => {
    if (String(url).includes("/dashboard/billing/")) return { ok: false, status: 404, json: async () => ({}) };
    if (String(url) === "https://api.deepseek.com/user/balance") {
      return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "4.65", granted_balance: "0.00", topped_up_balance: "4.65" }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await fetchBalance(entry, fakeFetch), "¥4.65（充值 4.65 / 赠送 0.00）");
});

test("fetchBalance：/user/balance 返回网页（json 解析失败）时按不支持处理", async () => {
  const { fetchBalance } = await import("../src/billing.js");
  const entry = { name: "spa-fallback-test", client: { baseURL: "https://relay.example/v1", apiKey: "sk-test" } };
  const fakeFetch = async (url) => {
    if (String(url).includes("/dashboard/billing/")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => { throw new Error("not json"); } };
  };
  assert.equal(await fetchBalance(entry, fakeFetch), null);
});
