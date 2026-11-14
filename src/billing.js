// API 余额查询：走 OpenAI 风格的账单接口（/dashboard/billing/*）。
// 不少中转支持用 API Key 直接查；不支持的（如余额只绑网站账号的公益站）
// 会返回 404，这里统一返回 null，命令层显示「不支持用 Key 查询」，不报错。

const CACHE_MS = 60_000;
const cache = new Map(); // 提供方名 -> { ts, text }

/**
 * 把账单接口的两个响应拼成人话。纯函数，可单测。
 * @param {object} subscription /dashboard/billing/subscription 的 JSON（含 hard_limit_usd）
 * @param {object} usage /dashboard/billing/usage 的 JSON（total_usage，单位是美分）
 * @returns {string|null} 余额描述；数据不可用返回 null
 */
export function formatBalance(subscription, usage) {
  if (!subscription || subscription.hard_limit_usd == null) return null;
  const hard = Number(subscription.hard_limit_usd);
  if (!Number.isFinite(hard)) return null;
  const used = Number((usage && usage.total_usage) || 0) / 100;
  if (hard >= 1e8) return `不限额（本月已用 $${used.toFixed(2)}）`;
  return `$${(hard - used).toFixed(2)}（总额 $${hard.toFixed(2)}，本月已用 $${used.toFixed(2)}）`;
}

/** 查单个提供方的余额文本；查不到返回 null。带 60 秒缓存，避免频繁打接口。 */
export async function fetchBalance(entry, fetchImpl = fetch) {
  const client = entry && entry.client;
  if (!client || !client.baseURL || !client.apiKey) return null;
  const hit = cache.get(entry.name);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.text;
  let text = null;
  try {
    const base = String(client.baseURL).replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${client.apiKey}` };
    const r1 = await fetchImpl(`${base}/dashboard/billing/subscription`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (r1.ok) {
      const sub = await r1.json();
      const now = new Date();
      const start = `${now.toISOString().slice(0, 7)}-01`;
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        .toISOString()
        .slice(0, 10);
      let usage = null;
      try {
        const r2 = await fetchImpl(
          `${base}/dashboard/billing/usage?start_date=${start}&end_date=${next}`,
          { headers, signal: AbortSignal.timeout(5000) },
        );
        if (r2.ok) usage = await r2.json();
      } catch {
        /* 已用额度查不到时按 0 处理，余额仍可显示 */
      }
      text = formatBalance(sub, usage);
    }
  } catch {
    text = null;
  }
  cache.set(entry.name, { ts: Date.now(), text });
  return text;
}

/** 全部提供方的余额报告（号主「账单」命令用）。 */
export async function balanceReport(entries, fetchImpl = fetch) {
  const lines = [];
  for (const e of entries || []) {
    const bal = await fetchBalance(e, fetchImpl);
    lines.push(`- ${e.name}：${bal ?? "不支持用 Key 查询（请到接口网站看）"}`);
  }
  return lines.join("\n");
}
