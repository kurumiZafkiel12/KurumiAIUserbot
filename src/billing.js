// API 余额查询：先试 OpenAI 风格的账单接口（/dashboard/billing/*），
// 再试 DeepSeek 风格的 /user/balance（官方接口，base 末尾的 /v1 要剥掉）。
// 都不支持的（如余额只绑网站账号的公益站）返回 null，
// 命令层显示「不支持用 Key 查询」，不报错。

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

const CURRENCY_SYMBOL = { CNY: "¥", USD: "$" };

/**
 * 把 DeepSeek 风格 /user/balance 的响应拼成人话。纯函数，可单测。
 * 只列余额非 0 的币种；全部为 0 时显示第一个币种的 0.00。
 * @param {object} data { is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
 * @returns {string|null} 余额描述；数据不可用返回 null
 */
export function formatVendorBalance(data) {
  if (!data || !Array.isArray(data.balance_infos) || data.balance_infos.length === 0) return null;
  const parts = [];
  for (const info of data.balance_infos) {
    const total = Number(info && info.total_balance);
    if (!Number.isFinite(total) || total === 0) continue;
    const sym = CURRENCY_SYMBOL[info.currency] || `${info.currency} `;
    const granted = Number(info.granted_balance) || 0;
    const topped = Number(info.topped_up_balance) || 0;
    parts.push(`${sym}${total.toFixed(2)}（充值 ${topped.toFixed(2)} / 赠送 ${granted.toFixed(2)}）`);
  }
  if (parts.length === 0) {
    const first = data.balance_infos[0] || {};
    const sym = CURRENCY_SYMBOL[first.currency] || `${first.currency || ""} `;
    return `${sym}0.00`;
  }
  return parts.join("；");
}

/** 查单个提供方的余额文本；查不到返回 null。带 60 秒缓存，避免频繁打接口。 */
export async function fetchBalance(entry, fetchImpl = fetch) {
  const client = entry && entry.client;
  if (!client || !client.baseURL || !client.apiKey) return null;
  const hit = cache.get(entry.name);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.text;
  let text = null;
  const base = String(client.baseURL).replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${client.apiKey}` };
  try {
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
  if (text === null) {
    // DeepSeek 风格：GET {origin}/user/balance（origin 是 base 剥掉末尾 /v1 等版本段）。
    // 中转若把这个路径回成网页（SPA 兜底），json 解析会失败，自然落回 null。
    try {
      const origin = base.replace(/\/v\d+(?:beta)?$/, "");
      const r3 = await fetchImpl(`${origin}/user/balance`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (r3.ok) {
        const data = await r3.json().catch(() => null);
        text = formatVendorBalance(data);
      }
    } catch {
      text = null;
    }
  }
  cache.set(entry.name, { ts: Date.now(), text });
  return text;
}

/** 全部提供方的余额报告（号主「账单」命令用）。并发查询（0.2.0）：串行时每个
 * 提供方最多 3×5 秒，接口一多命令就卡半分钟。 */
export async function balanceReport(entries, fetchImpl = fetch) {
  const list = entries || [];
  const bals = await Promise.all(list.map((e) => fetchBalance(e, fetchImpl)));
  return list.map((e, i) => `- ${e.name}：${bals[i] ?? "不支持用 Key 查询（请到接口网站看）"}`).join("\n");
}
