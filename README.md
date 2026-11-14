# KurumiAIUserbot

[![CI](https://github.com/kurumiZafkiel12/KurumiAIUserbot/actions/workflows/ci.yml/badge.svg)](https://github.com/kurumiZafkiel12/KurumiAIUserbot/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个跑在 **Telegram 个人账号**（userbot，不是 Bot API 机器人）上的 AI 聊天机器人。

它登录你的一个 Telegram 小号，监听私聊和群聊消息：别人 `@` 它或者用触发词提问，它就调用你配置的 AI 接口（OpenAI 兼容格式）流式生成回答，并把答案编辑回“正在思考中”的占位消息里。支持多个模型接口按权重轮换、失败自动切换、每日限额防刷，以及一组号主管理命令。

> ⚠️ userbot 用的是真人账号登录态，违反 Telegram 使用习惯的用法有封号风险。请务必使用**小号**，不要用你的主账号跑。

## 功能列表

- 私聊、群聊都能用：`@机器人用户名 + 问题`，或触发词 `@aa`～`@az` + 问题
- 流式回复：先发占位消息，生成过程中分段刷新，完成后替换为完整答案；超长答案自动分片
- 上下文：按「会话 + 提问者」保存最近对话（默认 20 条），能接上话；号主可一键清空
- 多模型池：多个 OpenAI 兼容接口（官方、第三方中转、自建服务都行），按权重挑选、失败冷却并自动换下一个
- 触发词绑定：不同触发词可以绑不同模型，例如 `@ai` 用 A 模型、`@ab` 用 B 模型
- 每日限额：每个模型可设每日调用上限，跨天自动清零，防止额度被刷爆
- 号主命令：查状态、查用量、拉黑/解封用户、清空上下文、查看触发词绑定
- 黑名单：被拉黑的用户提问一律不理；名单保存在 config.json 里，重启不丢
- 防刷冷却：普通用户两次提问至少间隔 5 秒（可配）
- 名字时钟（可选）：机器人显示名显示为「前缀 + 当前时间」，如 `GPT 13:45`，每分钟刷新，时区可配
- 日志：控制台 + 按天文件（`logs/bot-YYYY-MM-DD.log`），所有报错都进日志，不静默吞掉

## 目录

- [准备：申请 api_id / api_hash](#准备申请-api_id--api_hash)
- [安装](#安装)
- [配置 .env](#配置-env)
- [首次登录](#首次登录)
- [启动](#启动)
- [用 systemd 常驻（可选）](#用-systemd-常驻可选)
- [使用方法](#使用方法)
- [配置多模型（config.json）](#配置多模型configjson)
- [常见问题排错](#常见问题排错)
- [安全提醒](#安全提醒)
- [目录结构](#目录结构)
- [许可证](#许可证)

---

## 准备：申请 api_id / api_hash

userbot 登录个人号需要一对 Telegram 应用凭证，这是官方开放的：

1. 打开 https://my.telegram.org ，用你的 Telegram 手机号登录（验证码会发到 Telegram 应用内）。
2. 点 **API development tools**。
3. 第一次会让你创建一个应用：App title、Short name 随便填（例如 `myuserbot`），Platform 选 Desktop，点 Create。
4. 创建完成后页面上会显示 **api_id**（一串数字）和 **api_hash**（一串十六进制字符），记下来，下一步填进 `.env`。

注意：这对凭证是**你账号名下应用**的凭证，不要发给任何人、不要提交进 git 仓库。

## 安装

需要 Node.js 20 或更高版本。检查版本：

```bash
node -v   # 应显示 v20.x 或更高
```

没有 Node 的话：

- Windows / macOS：到 https://nodejs.org 下载 LTS 安装包。
- Linux（Debian/Ubuntu）：可以用 NodeSource 的脚本，或下载官方二进制包解压到 `/usr/local`。

然后拉代码并装依赖：

```bash
git clone <本仓库地址> kurumiaiuserbot
cd kurumiaiuserbot
npm install
```

## 配置 .env

复制示例文件：

```bash
cp .env.example .env
```

逐项说明：

| 变量 | 必填 | 说明 |
|---|---|---|
| `TELEGRAM_API_ID` | 是 | 上一步申请到的 api_id，纯数字 |
| `TELEGRAM_API_HASH` | 是 | 上一步申请到的 api_hash |
| `MY_USERNAME` | 是 | 机器人小号的用户名，不带 `@`。别人 `@` 这个名字就能触发它 |
| `OWNER_ID` | 是 | 你大号的**数字 ID**（不是用户名）。只有这个 ID 发出的号主命令才有效。查自己 ID 的办法：给任意一个查 ID 的机器人发消息，或看你客户端的个人资料页（部分第三方客户端会显示） |
| `AI_API_KEY` | 是 | 默认 AI 接口的密钥 |
| `AI_API_BASE` | 是 | 默认 AI 接口地址，OpenAI 兼容格式，一般以 `/v1` 结尾，如 `https://api.openai.com/v1`，或你的中转服务地址 |
| `AI_API_MODEL` | 是 | 默认模型名，如 `gpt-4o-mini`，以你的接口实际支持为准 |
| `TIMEZONE` | 否 | 时区，默认 `Asia/Shanghai`，影响名字时钟 |
| `NAME_PREFIX` | 否 | 名字时钟前缀，默认 `GPT`，显示成「GPT 13:45」 |
| `NAME_CLOCK` | 否 | `true` 开启名字时钟，`false` 关闭，默认开启 |

## 首次登录

```bash
npm run login
```

流程：

1. 程序会先醒目提示**手机号必须带国家区号**，然后让你输入小号的手机号。
   - 中国大陆：`+86` 开头，如 `+8613812345678`
   - 美国/加拿大：`+1` 开头，如 `+13825550137`
   - **区号填错，验证码会发到别人的账号上**，你这边永远等不到；之前就有人把 `+1` 的号码按 `+86` 输，码全发给了陌生人。
2. 输入手机号后，验证码**一般不走短信**，而是出现在 Telegram 应用里的 **“Telegram”官方服务通知对话**中。打开任意已登录该小号的客户端查看那串数字，回到终端输入。
3. 如果小号开了**两步验证**，接着输入两步验证密码（没开就直接回车）。
4. 整个过程必须**一口气在同一次运行里完成**：中途关掉终端重来，验证码会失效并报错 `PHONE_CODE_EXPIRED`。
5. 成功后会话会存到项目目录的 `.ai-session` 文件里。之后启动不用再输验证码，除非会话被 Telegram 注销。

## 启动

```bash
npm start
```

看到日志 `登录成功：@xxx，开始监听消息...` 就是跑起来了。`Ctrl+C` 停止。

## 用 systemd 常驻（可选）

在 Linux 服务器上可以用 systemd 让它开机自启、崩溃自动拉起。新建 `/etc/systemd/system/kurumiaiuserbot.service`：

```ini
[Unit]
Description=kurumiaiuserbot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/kurumiaiuserbot
ExecStart=/usr/local/bin/node src/index.js
Restart=on-failure
RestartSec=5
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` 改成你的实际安装路径，`node` 路径用 `which node` 查。然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kurumiaiuserbot
sudo systemctl status kurumiaiuserbot   # 看状态
journalctl -u kurumiaiuserbot -f        # 看日志
```

## 使用方法

### 提问（所有人）

- **提及触发**：在私聊或群里发 `@机器人用户名 + 问题`
  例：`@gpt88886666 北京今天天气怎么样`
- **触发词**：`@ai + 问题`（默认触发词），或其它已绑定的触发词
  例：`@ai 帮我把这句话翻译成英文：今天天气不错`
- 机器人会先回一条「正在思考中」，生成完毕后原地替换成答案；接着追问能带上文。
- 只发触发词、不写问题，它会提醒你补上问题。
- 提问太频繁会被冷却（默认 5 秒一次），冷却内的提问不回复。

### 号主命令（只有 OWNER_ID 本人可用）

号主命令以 `@ai ` 开头，在私聊或群里发都行：

| 命令 | 作用 |
|---|---|
| `@ai 状态` | 查看运行状态、已运行时长、提供方数量 |
| `@ai 用量` | 查看每个模型今日已用次数 / 每日上限 |
| `@ai 拉黑 <用户ID>` | 拉黑某用户，其提问一律不理（名单存 config.json） |
| `@ai 解封 <用户ID>` | 解除拉黑 |
| `@ai 清空上下文` | 清空全部对话上下文 |
| `@ai 绑定列表` | 查看每个触发词绑定了哪个模型 |

## 配置多模型（config.json）

在项目目录新建 `config.json` 可以加更多模型、绑触发词、设限额（字段详解见 [docs/CONFIG.md](docs/CONFIG.md)）：

```json
{
  "systemPrompt": "你是一个友好的 AI 助手，回答简洁准确。",
  "contextSize": 20,
  "cooldownSeconds": 5,
  "customProviders": [
    {
      "name": "relay-a",
      "baseURL": "https://example.com/v1",
      "apiKey": "sk-xxxxxxxx",
      "model": "model-a",
      "weight": 7,
      "dailyLimit": 200
    }
  ],
  "triggerMap": {
    "@ab": "relay-a"
  },
  "dailyLimits": {
    "default": 500
  }
}
```

改完 config.json 需要重启程序生效。`config.json` 里包含密钥，项目已把它列入 `.gitignore`，不要手工提交。

## 常见问题排错

### 私聊不回复，群里却正常（或反过来）

这是最经典的一个坑。Telegram 私聊消息走的是 `UpdateShortMessage` 简版更新：如果代码用 `client.addEventHandler(回调)` **裸注册**监听，回调里拿到的 `event.message` 不是完整消息对象（没有发送者、正文），私聊消息会被当作无效消息丢掉，看起来就是“私聊永远不回复，群里没事”。

本项目在 `src/index.js` 里用的是规范注册方式：

```js
import { NewMessage } from "telegram/events/index.js";
client.addEventHandler(handler, new NewMessage({}));
```

`NewMessage` 构建器会把简版更新统一转成标准消息对象，私聊和群聊走同一套处理逻辑。如果你魔改代码后出现“私聊不回”，先检查这里是不是被改回了裸注册。

### 发了问题，只停在“正在思考中”不动 / 没有任何回复

先看日志：程序日志在控制台和 `logs/` 目录里，**所有处理异常都会写进日志**。常见原因：

- AI 接口报错（密钥错、地址错、模型名不存在、余额不足）：日志里有 `提供方 xxx 回答失败：...`，按报错修 `.env`。
- 每个提供方都失败时，占位消息会被改成“所有模型都暂时不可用”。
- 如果日志里出现 `ReferenceError: xxx is not defined` 这类错误，说明代码里有未定义的变量在“答案已生成、发送前”崩了——同类项目真实出现过这种 bug（计数变量没定义，回复永远发不出去而且表面无报错）。本项目已把计数状态收敛到类里管理并有单元测试覆盖；魔改后请先跑 `npm test`。

### 在群里不回复：USER_BANNED_IN_CHANNEL

日志里出现 `发送占位消息失败 ... USER_BANNED_IN_CHANNEL`，说明机器人号在**那个群里被禁言了**（群管理机器人自动禁言或管理员手动禁言都可能）。程序再怎么重试也发不出消息，只能找群管理解除禁言。触发点通常是：短时间频繁测试、反复发占位/编辑消息被守卫机器人当成刷屏。测试时放慢频率。

### 验证码收不到 / 发错区号

- 先确认手机号带了正确国家区号（`+86` / `+1` 等）。区号错了，码会发到**别人**账号上。
- 码一般在 Telegram 应用内的官方服务通知对话里，不在短信里。
- 发码后不要关终端重开登录脚本，同一次运行里完成验码，否则报 `PHONE_CODE_EXPIRED`。

### 提示会话失效

日志提示会话失效（`.ai-session` 不能用了），通常是小号在别处重新登录、改了密码或被 Telegram 注销会话。删掉 `.ai-session`，重新 `npm run login` 即可。

### 名字时钟不动了

- 确认 `.env` 里 `NAME_CLOCK=true`，且程序在正常运行（改名日志：`已更新显示名：GPT 13:45`）。
- 客户端里看到的名字可能有缓存，点进机器人资料页刷新再看。
- 同一分钟内不会重复改名；跨分钟才刷新。

## 安全提醒

- **只用小号跑**，不要用主账号。userbot 行为（自动回复、高频编辑消息）有被 Telegram 风控甚至封号的可能。
- **api_id / api_hash、`.ai-session`、`.env`、`config.json` 都不要外泄、不要提交到公开仓库**。`.ai-session` 泄露等于账号被别人登录；本项目已把它们都写进 `.gitignore`。
- 不要图省事用网上流传的“Telegram Desktop 公开 api_id（2040）”之类**共享凭证**：那是给官方客户端用的，拿来跑 userbot 风控更严、容易触发限制，而且同一账号以后必须一直用同一套凭证登录。老老实实去 my.telegram.org 申请自己的（一分钟的事）。
- AI 接口的密钥只放在 `.env` / `config.json` 里，不要写进代码、不要截图发出去。
- 给模型设每日限额（见 config.json 的 `dailyLimits`），避免被刷爆额度产生费用。

## 目录结构

```text
.
├── src/
│   ├── index.js      入口：组装各模块、连接 Telegram、注册消息监听
│   ├── login.js      首次登录脚本（npm run login）
│   ├── config.js     读取 .env 与 config.json
│   ├── logger.js     控制台 + 按天文件日志
│   ├── triggers.js   触发词解析（纯函数，可测）
│   ├── limits.js     每日用量计数与跨天清零（纯逻辑，可测）
│   ├── providers.js  模型提供方池：加权挑选、失败冷却、流式调用
│   ├── context.js    对话上下文存储
│   ├── handlers.js   消息路由：触发问答、号主命令、黑名单、冷却
│   └── nameclock.js  显示名时钟
├── test/             单元测试（node --test，测触发解析与每日限额）
├── docs/CONFIG.md    config.json 字段详解
├── .env.example      环境变量模板
└── README.md
```

## 开发

```bash
npm test   # 跑单元测试
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
