// 工具状态存储：定时提醒（reminders.json）与待办清单（todos.json 的 todos 字段合并在同一文件里）。
// 提醒由 index.js 启的调度器每 30 秒扫一次，到点往原会话发消息；待办按「会话:用户」分键存。
// 落盘方式与记事本一致：写临时文件再改名，避免半截文件。

import fs from "node:fs";
import path from "node:path";

export class ToolStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { reminders: [], todos: {} };
    this.load();
  }

  load() {
    if (!this.filePath) return; // 无落盘路径（测试/默认依赖）：纯内存模式
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.reminders)) this.data.reminders = parsed.reminders;
        if (parsed.todos && typeof parsed.todos === "object") this.data.todos = parsed.todos;
      }
    } catch {
      // 文件不存在或损坏：从空开始，不因此让主流程崩。
    }
  }

  save() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  addReminder({ chatId, senderId, senderName, text, at }) {
    const item = {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      chatId: String(chatId),
      senderId: String(senderId),
      senderName: String(senderName || ""),
      text: String(text),
      at: String(at),
    };
    this.data.reminders.push(item);
    this.save();
    return item;
  }

  listReminders(chatId) {
    return this.data.reminders
      .filter((r) => r.chatId === String(chatId))
      .sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  /** 取走所有已到点的提醒（取出即删除，避免重复触发）。 */
  takeDueReminders(now = new Date()) {
    const due = [];
    const keep = [];
    for (const r of this.data.reminders) {
      (new Date(r.at) <= now ? due : keep).push(r);
    }
    if (due.length) {
      this.data.reminders = keep;
      this.save();
    }
    return due;
  }

  addTodo(key, text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("待办内容是空的");
    const list = this.data.todos[key] || (this.data.todos[key] = []);
    list.push(t);
    this.save();
    return list;
  }

  listTodos(key) {
    return this.data.todos[key] || [];
  }

  doneTodo(key, index) {
    const list = this.data.todos[key] || [];
    const i = Math.trunc(Number(index)) - 1;
    if (!Number.isFinite(i) || i < 0 || i >= list.length) return null;
    const [removed] = list.splice(i, 1);
    this.save();
    return removed;
  }

  clearTodos(key) {
    delete this.data.todos[key];
    this.save();
  }
}

/** 到点提醒的文案：带上设定者的文字提及（tg://user 链接），对方才会收到 @ 提醒；
 * 只发一条干巴巴的「提醒：…」到群里，设定者多半看不见（v0.9.15 修）。 */
export function reminderFireText(r) {
  const label = String(r.senderName || "").replace(/[\[\]()]/g, "").trim() || "你";
  const mention = r.senderId ? `[${label}](tg://user?id=${r.senderId}) ` : "";
  return `${mention}提醒：${r.text}`;
}

/**
 * 提醒调度器：每 30 秒检查一次到点提醒，发到原会话。
 * 发送失败只记日志并放弃该条（不无限重试刷屏）。
 * @returns {Function} 停止函数
 */
export function startReminderScheduler(client, store, logger) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const due = store.takeDueReminders(new Date());
    for (const r of due) {
      try {
        await client.sendMessage(r.chatId, { message: reminderFireText(r) });
        logger.info(`已发送提醒（chat=${r.chatId}）：${r.text}`);
      } catch (err) {
        logger.error(`发送提醒失败（chat=${r.chatId}）：${err.message}`);
      }
    }
  };
  const timer = setInterval(() => {
    tick().catch((err) => logger.error(`提醒调度出错：${err.message}`));
  }, 30_000);
  if (timer.unref) timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
