// 工具状态存储：定时提醒（reminders.json）与待办清单（todos.json 的 todos 字段合并在同一文件里）。
// 提醒由 index.js 启的调度器每 30 秒扫一次，到点往原会话发消息；待办按「会话:用户」分键存。
// 落盘方式与记事本一致：写临时文件再改名，避免半截文件。

import fs from "node:fs";
import path from "node:path";
import { Api } from "telegram";

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

  addReminder({ chatId, senderId, senderName, senderAccessHash, text, at }) {
    const item = {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      chatId: String(chatId),
      senderId: String(senderId),
      senderName: String(senderName || ""),
      senderAccessHash: String(senderAccessHash || ""),
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

/** 到点提醒里设定者的称呼（清洗掉会破坏实体/排版的字符）。 */
export function reminderMentionLabel(r) {
  return String(r.senderName || "").replace(/[\[\]()]/g, "").trim() || "你";
}

/** 到点提醒的纯文本。提及不靠 markdown：GramJS 的 markdown 解析器只认 ** 等
 * 定界符、不认 [文字](链接) 语法——v0.9.15 写的 tg:// 链接被原样发了出去（群内实测）。
 * 真提及由调度器另附 InputMessageEntityMentionName 实体（v0.9.19 定版：非 Input 版
 * 的 user_id 是 long 型、塞 InputUser 序列化直接抛错，见调度器处注释）。 */
export function reminderFireText(r) {
  return `${reminderMentionLabel(r)} 提醒：${r.text}`;
}

/**
 * 把设定者解析成 InputUser（构建 MentionName 实体用）。GramJS 的实体缓存是
 * 每连接一份、冷启动为空，v0.9.16 只靠到点时 getInputEntity 直查，缓存没有就
 * 静默失败（群内实测 @ 不出来）。三级兜底：① 设定时捕获落盘的 accessHash；
 * ② 实体缓存直查；③ 扫原会话近期消息把设定者实体预热进缓存再查。
 * 都失败返回 null（调度器退回纯文本并记日志）。
 */
export async function resolveReminderInputUser(client, r) {
  const uid = String(r.senderId || "");
  if (!uid || !client) return null;
  if (r.senderAccessHash) {
    try {
      const ah = BigInt(r.senderAccessHash);
      if (ah !== BigInt(0)) return new Api.InputUser({ userId: BigInt(uid), accessHash: ah });
    } catch {
      // accessHash 损坏就落到下面的查缓存路径。
    }
  }
  const fromPeer = (p) =>
    p && p.userId !== undefined
      ? new Api.InputUser({ userId: p.userId, accessHash: p.accessHash || BigInt(0) })
      : null;
  try {
    const u = fromPeer(await client.getInputEntity(uid));
    if (u) return u;
  } catch {
    // 缓存里没有：预热再试。
  }
  try {
    await client.getMessages(r.chatId, { limit: 50 });
    return fromPeer(await client.getInputEntity(uid));
  } catch {
    return null;
  }
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
      const text = reminderFireText(r);
      try {
        // 真 @：附 InputMessageEntityMentionName 实体（offset/length 按 UTF-16 计数，
        // JS 字符串 length 即 UTF-16 单元数）；用户实体三级解析见 resolveReminderInputUser。
        // 必须用 Input 版：本 GramJS 版本的 MessageEntityMentionName 的 user_id 是 long 型，
        // 塞 InputUser 会在序列化时抛 CastError、塞裸 ID 又会被服务器丢弃实体——v0.9.16/17
        // 两版都栽在这里（2026-11-22 探针回读实证：Input 版回读到 MessageEntityMentionName）。
        let entities;
        let failReason = "";
        const inputUser = await resolveReminderInputUser(client, r).catch(() => null);
        if (inputUser) {
          entities = [
            new Api.InputMessageEntityMentionName({
              offset: 0,
              length: reminderMentionLabel(r).length,
              userId: inputUser,
            }),
          ];
        } else {
          failReason = "未带上 @：设定者实体解析失败";
        }
        try {
          await client.sendMessage(r.chatId, { message: text, formattingEntities: entities });
        } catch (err) {
          if (!entities) throw err;
          // 带实体发送失败（多半是 accessHash 失效）：退回纯文本，保证提醒本身送达。
          failReason = `未带上 @：带实体发送失败（${err.message}）`;
          entities = undefined;
          await client.sendMessage(r.chatId, { message: text });
        }
        // 是否带上 @ 必须进日志、且区分失败原因：v0.9.16 静默退回纯文本、日志还报成功，
        // v0.9.17 的日志又把序列化失败误报成解析失败，问题无从定位。
        if (entities) logger.info(`已发送提醒（带 @）（chat=${r.chatId}）：${r.text}`);
        else logger.info(`已发送提醒（${failReason}）（chat=${r.chatId}）：${r.text}`);
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
