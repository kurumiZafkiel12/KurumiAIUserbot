// 运行时状态：目前只有一样东西——全局暂停开关（paused）。
// 创建者发 `@ai 关闭` 后机器人进入暂停：谁的提问都不回、不调模型，防止
// 创建者不在时被人刷爆 token；发 `@ai 开启` 恢复。开关必须跨重启有效，
// 所以持久化到构造时传入的 JSON 文件（state.json）；文件损坏按未暂停处理，绝不抛错。

import fs from "node:fs";

export class RuntimeState {
  /**
   * @param {string|null} filePath 持久化文件路径（如 state.json）；null 表示只用内存不落盘
   */
  constructor(filePath) {
    this.path = filePath || null;
    this.paused = false;
    this._load();
  }

  _load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      if (data && typeof data === "object") {
        this.paused = data.paused === true;
      }
    } catch {
      // 文件损坏/不可读：按未暂停启动（宁可正常回复，不要被坏文件锁死）。
      this.paused = false;
    }
  }

  _save() {
    if (!this.path) return;
    try {
      fs.writeFileSync(this.path, JSON.stringify({ paused: this.paused }, null, 2) + "\n", "utf-8");
    } catch {
      // 写盘失败不抛错，开关退化为内存版（本次运行内仍然有效）。
    }
  }

  /** 当前是否处于全局暂停。 */
  isPaused() {
    return this.paused;
  }

  /**
   * 设置全局暂停并落盘。
   * @returns {boolean} 暂停状态是否发生了变化（没变时不写盘）
   */
  setPaused(value) {
    const next = Boolean(value);
    if (next === this.paused) return false;
    this.paused = next;
    this._save();
    return true;
  }
}
