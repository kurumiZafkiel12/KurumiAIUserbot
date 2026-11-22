// 模型自动识别：提供方没填模型名时，启动时向接口的 /models 端点问它支持哪些模型，
// 从中挑一个能聊天的用——省掉「必须先知道确切模型名才能部署」这一步（实测踩过：
// 模型名留空默认 gpt-4o-mini、拿去问只认自家模型名的接口，直接被 400 拒）。
// 识别失败不拦启动：退回 gpt-4o-mini 并打醒目警告（多半会被接口拒，但状态可查）。

/** 非聊天模型关键词：出现在模型名里的一律不选（向量/语音/画图/审核等）。 */
const EXCLUDE_RE = /(embed|whisper|tts|audio|image|dall|moderation|rerank|transcri|realtime|sora|video|ocr|guard)/i;
/** 轻量档关键词：同档里优先挑便宜快的当默认。 */
const LIGHT_RE = /(flash|mini|haiku|lite|turbo|small)/i;

/**
 * 从模型 ID 列表里挑一个聊天模型：先找名字带 chat 的（如 deepseek-chat），
 * 再找轻量档（flash/mini 等），都没有就用列表第一个（接口通常把主力放前面）。
 * 挑不到返回 null。
 */
export function pickModel(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || "")).filter((id) => id && !EXCLUDE_RE.test(id));
  if (!list.length) return null;
  const chat = list.find((id) => /(^|[-/_.])chat($|[-/_.])/i.test(id) || id.toLowerCase().endsWith("chat"));
  if (chat) return chat;
  const light = list.find((id) => LIGHT_RE.test(id));
  if (light) return light;
  return list[0];
}

/** 向 {baseURL}/models 查询可用模型并挑一个；任何失败都返回 null（不抛错）。 */
export async function detectModel(baseURL, apiKey, fetchImpl = fetch) {
  const url = `${String(baseURL || "").replace(/\/+$/, "")}/models`;
  if (!url.startsWith("http")) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const arr = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : [];
    const ids = arr.map((m) => (typeof m === "string" ? m : m && (m.id || m.name))).filter(Boolean);
    return pickModel(ids);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const FALLBACK_MODEL = "gpt-4o-mini";

/**
 * 启动时补齐没填模型名的提供方：能识别就用识别结果（标 modelAuto），
 * 识别不到退回 FALLBACK_MODEL 并警告。就地修改 providers 数组里的对象。
 */
export async function ensureProviderModels(providers, logger, fetchImpl = fetch) {
  const keyProp = "api" + "Key";
  for (const p of providers || []) {
    if (!p || p.model) continue;
    const found = p.baseURL ? await detectModel(p.baseURL, p[keyProp], fetchImpl) : null;
    if (found) {
      p.model = found;
      p.modelAuto = true;
      if (logger) logger.info(`提供方 ${p.name} 未填模型名，已自动识别为 ${found}`);
    } else {
      p.model = FALLBACK_MODEL;
      if (logger) logger.warn(`提供方 ${p.name} 未填模型名且自动识别失败，先按 ${FALLBACK_MODEL} 试；若接口不认这个名字，请在 .env 填 AI_API_MODEL`);
    }
  }
}

/**
 * 配置重载时（同步路径，没法再发网络请求）：把上次已识别/已填的模型按提供方名
 * 继承过来；仍为空的退回 FALLBACK_MODEL 并警告。就地修改 freshProviders。
 */
export function inheritModels(freshProviders, previousProviders, logger) {
  const prev = new Map((previousProviders || []).filter((p) => p && p.name && p.model).map((p) => [p.name, p]));
  for (const p of freshProviders || []) {
    if (!p || p.model) continue;
    const old = prev.get(p.name);
    if (old) {
      p.model = old.model;
      p.modelAuto = old.modelAuto === true;
    } else {
      p.model = FALLBACK_MODEL;
      if (logger) logger.warn(`提供方 ${p.name} 未填模型名，重载时无可继承的识别结果，先按 ${FALLBACK_MODEL} 试`);
    }
  }
}
