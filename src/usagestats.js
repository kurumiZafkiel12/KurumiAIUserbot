// Token 用量统计：按天、按模型累计调用次数与 prompt/completion/total token。
// 数据来自流式响应的 usage 字段（stream_options.include_usage）；接口不给 usage 时
// 只记次数、token 记 0。落盘 usage.json（仿 state.js 的容错风格）：跨天自动归零，
// 文件损坏按空统计启动，绝不抛错。

import fs from "node:fs";
import { todayKey } from "./limits.js";

function emptyDay(day) {
  return { day, models: {} };
}

export class UsageStats {
  /**
   * @param {string|null} filePath 持久化文件路径（如 usage.json）；null 表示只用内存不落盘
   */
  constructor(filePath) {
    this.path = filePath || null;
    this.data = emptyDay(todayKey());
    this._load();
  }

  _load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      if (raw && typeof raw === "object" && typeof raw.day === "string" && raw.models && typeof raw.models === "object") {
        this.data = { day: raw.day, models: {} };
        for (const [model, rec] of Object.entries(raw.models)) {
          if (!rec || typeof rec !== "object") continue;
          this.data.models[model] = {
            calls: Number(rec.calls) || 0,
            prompt: Number(rec.prompt) || 0,
            completion: Number(rec.completion) || 0,
            total: Number(rec.total) || 0,
          };
        }
      }
    } catch {
      // 文件损坏/不可读：按空统计启动。
      this.data = emptyDay(todayKey());
    }
    this._rollover();
  }

  _save() {
    if (!this.path) return;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
    } catch {
      // 写盘失败不抛错，统计退化为内存版。
    }
  }

  /** 跨天则归零。返回是否发生了归零。 */
  _rollover(now = new Date()) {
    const key = todayKey(now);
    if (key !== this.data.day) {
      this.data = emptyDay(key);
      return true;
    }
    return false;
  }

  /**
   * 记一次成功调用。
   * @param {string} model 模型名
   * @param {object|null} usage 接口返回的 usage（{prompt_tokens, completion_tokens, total_tokens}），
   *   没有就传 null（只记次数）。
   */
  record(model, usage, now = new Date()) {
    if (!model) return;
    this._rollover(now);
    const rec = this.data.models[model] || (this.data.models[model] = { calls: 0, prompt: 0, completion: 0, total: 0 });
    rec.calls += 1;
    if (usage && typeof usage === "object") {
      const p = Number(usage.prompt_tokens) || 0;
      const c = Number(usage.completion_tokens) || 0;
      const t = Number(usage.total_tokens) || p + c;
      rec.prompt += p;
      rec.completion += c;
      rec.total += t;
    }
    this._save();
  }

  /**
   * 今日统计快照。
   * @returns {{ day: string, models: Object<string, {calls:number, prompt:number, completion:number, total:number}>,
   *   totals: {calls:number, prompt:number, completion:number, total:number} }}
   */
  snapshot(now = new Date()) {
    this._rollover(now);
    const totals = { calls: 0, prompt: 0, completion: 0, total: 0 };
    for (const rec of Object.values(this.data.models)) {
      totals.calls += rec.calls;
      totals.prompt += rec.prompt;
      totals.completion += rec.completion;
      totals.total += rec.total;
    }
    return { day: this.data.day, models: this.data.models, totals };
  }
}
