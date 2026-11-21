# config.json 配置详解

`config.json` 放在项目根目录（与 `.env` 同级），是**可选**文件：不建它时，程序只用 `.env` 里的默认接口运行。

它的用途是放 `.env` 装不下的东西：多个模型接口、每日限额、系统提示词等。**手工编辑**这个文件后需要重启程序才生效；但用号主命令改的（限额、换 key、人设、名单等）都是写文件后立刻在线重载，**立即生效、不用重启**。

> ⚠️ `config.json` 里会写 AI 接口密钥，项目已把它列入 `.gitignore`。不要手工提交到任何仓库，不要截图外发。

## 完整示例

```json
{
  "systemPrompt": "你是一个友好的 AI 助手，在 Telegram 里回答问题，回答简洁准确。",
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
    },
    {
      "name": "relay-b",
      "baseURL": "https://another.example.com/v1",
      "apiKey": "sk-yyyyyyyy",
      "model": "model-b",
      "weight": 3,
      "dailyLimit": 0
    }
  ],
  "dailyLimits": {
    "default": 500
  },
  "adminIds": ["123456789"],
  "ignoreSenderIds": [],
  "privateChat": "all",
  "blacklist": [],
  "usernameTrigger": true,
  "slowdownUsers": [],
  "codeKeywords": [],
  "sensitiveGroups": [],
  "sensitiveKeywords": [],
  "defaultProvider": "",
  "providerOverrides": {},
  "poJia": "",
  "visionPool": { "relay-a": [{ "model": "vision-model", "weight": 7 }] },
  "ttsApiBase": "",
  "ttsApiKey": "",
  "voiceBook": { "塔菲": "voice-id-1" },
  "voicePersona": {},
  "saySwitch": {},
  "voiceSwitch": {},
  "voiceByChat": {},
  "voiceByChatUser": {},
  "recordGroups": [],
  "recordContextLimit": {},
  "searchApiKey": "",
  "customName": { "first": "", "last": "" }
}
```

## 字段说明

### systemPrompt（字符串，可选）

发给模型的系统提示词。缺省时使用程序内置的一句通用提示词。

### contextSize（数字，可选，默认 20）

每组对话（同一会话里同一个提问者）最多保留的历史消息条数，user 与 assistant 合计计数。超出的最早消息会被丢弃。设得越大越能“记事”，但每次请求带的历史也越长、越费 token。

### cooldownSeconds（数字，可选，默认 5）

普通用户两次提问之间的最短间隔（秒）。间隔内的提问会被直接忽略，防止刷屏烧额度。设为 0 表示关闭冷却。号主不受冷却限制。

### customProviders（数组，可选，默认空）

追加的模型接口列表。加上 `.env` 定义的默认接口（名字固定为 `default`），共同组成提供方池：提问时会按权重挑一个调用，失败自动换下一个（失败的接口冷却 30 秒）。

每个元素字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 提供方名字，自己起，英文/数字/短横线，如 `relay-a`。每日限额等都按这个名字引用。不要与 `default` 重名 |
| `baseURL` | 是 | OpenAI 兼容接口地址，一般以 `/v1` 结尾 |
| `apiKey` | 是 | 该接口的密钥 |
| `model` | 是 | 模型名，以接口实际支持为准 |
| `weight` | 否 | 挑选权重，默认 1。权重越大被选中的概率越高（权重 7 与 3 ≈ 70% 与 30%） |
| `dailyLimit` | 否 | 每日调用上限，默认 0 = 不限。达到上限后当天不再选它 |

### dailyLimits（对象，可选，默认空）

按提供方名字覆盖每日上限，适合不想改 customProviders 写法、只想统一管限额的情况。例如 `{ "default": 500 }` 表示 `.env` 的默认接口每天最多调 500 次。这里的值优先于 customProviders 元素里的 `dailyLimit`。

计数按程序所在机器的本地日期统计，每天零点过后自动清零（跨天第一次调用时惰性清零，不需要重启）。

### adminIds（数组，可选，默认空，程序也会维护）

管理员的用户数字 ID 列表（字符串数组）。管理员是创建者之下的一档：不能跑号主命令，但 `privateChat` 设为 `"admins"` 时可以私聊机器人。创建者用 `/ai 加管理员 <ID>` / `/ai 删管理员 <ID>` / `/ai 管理员列表` 命令增删时程序会自动读写这个字段，立即生效；手工编辑则改完重启生效。创建者本人（`.env` 的 `OWNER_ID`）不需要、也不应该写进这个名单。

### ignoreSenderIds（数组，可选，默认空）

忽略名单（用户 ID 数组）。名单内账号的消息一律不处理；典型用途：同一个群里还有另一个机器人号时，互加对方 ID，两个号永不互相触发。只写本地 config.json。

### privateChat（字符串，可选，默认 `"all"`）

私聊门禁模式：

- `"all"`：任何人都可以私聊机器人提问（默认行为）。
- `"admins"`：只有创建者与 `adminIds` 里的管理员能私聊；普通用户的私聊消息会被静默忽略（日志里记一条）。群聊完全不受影响。

除 `"admins"` 外的任何值都按 `"all"` 处理。

### blacklist（数组，程序维护，不要手工乱改）

被拉黑的用户数字 ID 列表（字符串数组）。号主用 `/ai 拉黑 <ID>` / `/ai 解封 <ID>` 命令时程序会自动读写这个字段。手工编辑也行，改完重启生效。

### usernameTrigger（布尔，可选，默认 true）

用户名触发开关。设为 `false` 后，**普通用户**在群里 `@机器人用户名` 不再触发问答；回复机器人消息续聊、私聊直发都不受影响，创建者与管理员 `@用户名` 照常能触发。号主用 `/ai 关闭用户名` / `/ai 开启用户名` 在线切换，立即生效。

### slowdownUsers（数组，程序维护）

被限速的用户数字 ID 列表（字符串数组）。名单内的人每次被成功回答后，进入一段递增冷却：5 → 10 → 30 → 60 分钟（封顶 60），冷却内他的提问会被静默忽略（日志里记一条）。号主用 `/ai 限速 <ID>` / `/ai 解除限速 <ID>` 维护这个字段；解除时冷却与递增档位一并清零。冷却状态本身只存内存，程序重启后从第一档重新开始。

### codeKeywords（数组，程序维护）

代码关键词列表。**普通用户**的问题命中任一关键词（不分大小写的子串匹配）时，机器人不调模型，只回一条提醒并计数；同一用户累计第 3 次命中会被**自动拉黑**。号主与管理员豁免。号主用 `/ai 加词 <词…>` / `/ai 删词 <词…>` 维护（可一次发多个词，空格分隔），回执带新增/已存在计数。命中计数只存内存，重启清零。

### sensitiveGroups / sensitiveKeywords（数组，程序维护）

屏蔽群（群数字 ID，字符串数组）与屏蔽词。规则：在屏蔽群里，任何人（号主除外）触发的问题命中任一屏蔽词，就静默不回（日志里记一条）。注意屏蔽词是**全局一份、对所有屏蔽群都生效**，不是按群分开的。号主用 `/ai 加屏蔽 <群ID> <词>` 添加（一次加一个词，顺带把群登记进屏蔽群名单）。

### defaultProvider（字符串，可选，默认空）

默认提供方名字。所有提问（`@机器人用户名` 提及、回复续聊、私聊直发）在挑选提供方时优先用它；为空时用名为 `default` 的提供方（即 `.env` 那个）。它只是「优先」，不可用（超限/冷却/被禁用）时仍会回退到池里其他可用的。号主用 `/ai 换模型`（再回序号）在线设置，立即生效。

### providerOverrides（对象，程序维护）

按提供方名字写的覆盖项，合并到对应提供方定义上（包括 `.env` 的 `default`）：

```json
"providerOverrides": {
  "default": { "apiKey": "sk-新的key", "disabled": false },
  "relay-a": { "disabled": true }
}
```

- `apiKey`：覆盖该提供方的密钥（`/ai 换key` 写这里，所以换 `.env` 那个接口的 key 也不用改 `.env`、不用重启）。
- `disabled`：`true` 表示禁用，该提供方不再被挑中（`/ai 禁用api` / `/ai 启用api` 写这里；最后一个启用的提供方禁不掉）。

这个字段由号主命令维护，一般不要手工改；手工改完要重启才生效。

### poJia（字符串，可选，默认空，程序也会维护）

破甲内容：注入系统提示时排在人设之前、优先级最高。用 `/ai 破甲 <内容>` 设置、`/ai 清除破甲` 清除。**只应保存在本地 config.json（已在 .gitignore 里），不要提交到任何仓库。**

### visionPool（对象，可选，默认空，程序维护）

识图池：`{ API名字: [{ "model": "识图模型名", "weight": 权重 }] }`。发照片提问时按权重从池里选条目，用该 API 的地址与 key、以条目的 model 发带图请求。用 `/ai 加识图` / `/ai 删识图` / `/ai 识图权重` / `/ai 识图列表` 维护，一般不用手改。

### ttsApiBase / ttsApiKey（字符串，可选，默认空，程序也会维护）

语音合成（TTS）接口地址与 key（Fish Audio 风格：POST 到 ttsApiBase 本身，body 带 text 与 reference_id）。用 `/ai 换tts接口` / `/ai 换ttskey` 改，立即生效；也可以在 .env 里用 `TTS_API_BASE` / `TTS_API_KEY` 兜底（config.json 里写了就以 config.json 为准）。

### voiceBook / voicePersona（对象，程序维护）

音色库 `{ 音色名: 音色ID }` 与音色人格 `{ 音色名: 人格提示词 }`。用 `/ai 加音色` / `/ai 删音色` / `/ai 加人格` / `/ai 删人格` 维护。人格的作用：本群开启「说」且当前音色有人格时，人格会拼进系统提示塑造说话风格，回答文本随后合成语音。

### saySwitch / voiceSwitch（对象，程序维护）

按群开关：`{ 群ID: true/false }`。saySwitch 是「开启说」（回答后追加语音），voiceSwitch 是「开启换音色」（群友可自选音色）。用 `/ai 开启说` 等命令在目标群里切换。

### voiceByChat / voiceByChatUser（对象，程序维护）

音色选择：voiceByChat 是整群的当前音色 `{ 群ID: 音色名 }`（号主选）；voiceByChatUser 是个人在本群的自选音色 `{ "群ID_用户ID": 音色名 }`。挑选顺序：个人 > 整群 > 音色库第一个。

### recordGroups / recordContextLimit（数组 / 对象，程序维护）

recordGroups 是开启了聊天记录的群 ID 列表（`/ai 开启记录`）；recordContextLimit 是每个群回答时带入的最近记录条数 `{ 群ID: 数字 }`（默认 100，`/ai 记录条数` 改）。记录本体存在 records.json（见下方运行时数据文件）。

### searchApiKey（字符串，可选，默认空，程序也会维护）

联网搜索的 key（Serper 风格；问题带「联网搜索」时走 Tavily 深搜，地址可用 searchApiBase / searchApiBase2 覆盖默认）。用 `/ai 换搜索key` 改（写 config.json、不写 .env、立即生效）；.env 的 `SEARCH_API_KEY` 可作兜底。不配则搜索功能整体不启用。

### customName（对象，可选，程序也会维护）

`/ai 改名` 落盘的账号名 `{ "first": 名字, "last": 姓氏 }`。设了之后，名字时钟的显示名用它打头（姓氏 + 时间）替代 .env 的 NAME_PREFIX；没设时维持原前缀逻辑。

## 最小示例：只加一个备用模型

```json
{
  "customProviders": [
    {
      "name": "backup",
      "baseURL": "https://example.com/v1",
      "apiKey": "sk-xxxxxxxx",
      "model": "model-backup",
      "weight": 5,
      "dailyLimit": 100
    }
  ]
}
```

这样：提问默认用 `.env` 的默认接口；默认接口要是挂了，会自动落到 backup 上（提供方池失败切换对所有可用接口生效）。

## 运行时数据文件（不是配置项，程序自动维护）

下面几个文件不在 config.json 里，而是程序运行时在运行目录下自动生成和读写的数据。一般不用管；这里说明它们是什么，免得看到时疑惑。

### facts.json（事实记事本）

按会话（chatId）保存的事实清单，每会话最多 25 条。来源有两个：号主用 `/ai 记住 <内容>` 手工添加；以及每个会话答满 4 次后，后台让模型把「现有记事本 + 最近对话」自动整理出的结果（全量替换）。每次回答前，当前会话的记事本会注入系统提示。管理命令：`/ai 记事本` / `/ai 忘掉 <序号>` / `/ai 清空记事本`。想让机器人彻底忘掉所有会话的事实，停机后删掉这个文件再启动。

### profiles.json（用户档案）

按用户（userId）保存 `{ callName, impression }`：

- `callName`：用户本人在消息里说「叫我 X」时由程序自动识别并记下的称呼，之后机器人称呼他、转述他的话都用它，不用显示名。
- `impression`：后台整理记事本时，顺带根据该用户最近发言更新的一两句印象（风格/话题/氛围/公开小事，不记隐私），只用于调整跟他说话的语气，绝不外泄。

想清掉所有人的档案，停机后删掉这个文件再启动。两个文件都已在 `.gitignore` 里，不会被提交到仓库。

### records.json（群聊天记录）

按群保存开启了记录的群的消息（显示名 + 文本 + 时间），每群最多 1000 条、环形覆盖最旧的。回答开启记录的群里的问题时，最近 N 条会拼进系统提示（只给显示名，不给数字 ID）。用 `/ai 开启记录` / `/ai 关闭记录` 控制哪些群记录；想彻底清掉，停机后删掉这个文件再启动。已在 `.gitignore` 里。

### state.json（运行时状态）

只存一个字段：`paused`（全局暂停开关）。创建者发 `/ai 关闭` 后写入 `true`，机器人暂停回复所有人的提问；发 `/ai 开启` 后写回 `false`。重启后保持关闭状态。若机器人重启后不回话、先怀疑它被关着：看 `/ai 状态`，或停机后删掉这个文件（回到未暂停）再启动。

### usage.json（Token 用量统计）

按天、按模型累计的 token 用量：每次成功回答后，把流式响应末尾 usage 里的 prompt/completion/total 累加进来（接口不给 usage 时只记次数、token 记 0）。`/ai 账单` 展示今日 Token 合计，`/ai 用量报告` 展示按模型的明细。跨天自动归零；文件损坏时按空统计启动，不会影响回答。
