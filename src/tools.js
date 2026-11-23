// 内置工具集（v0.8.0）：不需要任何 API Key 的实用功能，照 tgai 时代的功能面原创实现。
// - 本地工具：纯计算，不联网（编解码、哈希、换算、抽签、塔罗、黄历等）。
// - 联网工具：只调免费公开接口（Open-Meteo、百度热搜、CoinGecko、豆瓣等），失败时如实回报不可用，绝不编造数据。
// 触发方式：聊天管线判定问题可能需要工具时（toolGate），把工具表交给模型，由模型决定调用；
// 结果回喂给模型组织成自然回复——不是脚本罐头答复。

import crypto from "node:crypto";

/* ---------------- 通用小工具 ---------------- */

const FETCH_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchWithTimeout(url, options = {}) {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
try {
return await fetch(url, {...options, signal: ctrl.signal, headers: { "User-Agent": UA,...(options.headers || {})}});
} finally {
clearTimeout(timer);
}
}

async function fetchJson(url, options = {}) {
const res = await fetchWithTimeout(url, options);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
return res.json();
}

/** 工具结果文本截断，防把上下文撑爆。 */
function cap(text, limit = 2200) {
const s = String(text?? "");
return s.length > limit? `${s.slice(0, limit)}…（已截断）`: s;
}

function hashSeed(str) {
let h = 2166136261;
for (let i = 0; i < str.length; i++) {
h ^= str.charCodeAt(i);
h = Math.imul(h, 16777619);
}
return h >>> 0;
}

/** 确定性伪随机（同一输入同一结果，黄历/运势按天稳定）。 */
function seededRandom(seed) {
let a = seed >>> 0;
return () => {
a |= 0;
a = (a + 0x6d2b79f5) | 0;
let t = Math.imul(a ^ (a >>> 15), 1 | a);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}

/** 取某时区今天的 yyyy-mm-dd。 */
function todayInTz(timezone, date = new Date()) {
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(date);
const get = (t) => parts.find((p) => p.type === t).value;
return `${get("year")}-${get("month")}-${get("day")}`;
}

/* ---------------- 本地工具：编解码与文本 ---------------- */

const MORSE_ENCODE = {
A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
".": ".-.-.-", ",": "--..--", "?": "..--..", "!": "-.-.--", ":": "---...", "/": "-..-.", " ": "/",
};
const MORSE_DECODE = Object.fromEntries(Object.entries(MORSE_ENCODE).map(([k, v]) => [v, k]));

export function base64Tool(text, mode) {
if (mode === "decode") {
const s = String(text).replace(/\s+/g, "");
if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) throw new Error("这串内容不像 Base64");
return Buffer.from(s, "base64").toString("utf-8");
}
return Buffer.from(String(text), "utf-8").toString("base64");
}

export function urlCodecTool(text, mode) {
return mode === "decode"? decodeURIComponent(String(text)): encodeURIComponent(String(text));
}

export function morseTool(text, mode) {
const s = String(text);
if (mode === "decode") {
return s.trim().split(/\s+/).map((tok) => (tok === "/"? " ": MORSE_DECODE[tok] || "?")).join("");
}
return s.toUpperCase().split("").map((ch) => MORSE_ENCODE[ch] || "").filter(Boolean).join(" ");
}

export function hashTool(text, algo) {
const a = String(algo || "sha256").toLowerCase();
if (!["md5", "sha1", "sha256", "sha512"].includes(a)) throw new Error(`不支持的哈希算法：${a}`);
return crypto.createHash(a).update(String(text), "utf-8").digest("hex");
}

export function jsonTool(text, mode) {
let obj;
try {
obj = JSON.parse(String(text));
} catch (err) {
throw new Error(`JSON 不合法：${err.message}`);
}
return mode === "minify"? JSON.stringify(obj): JSON.stringify(obj, null, 2);
}

export function baseConvertTool(value, fromBase, toBase) {
const from = Number(fromBase);
const to = Number(toBase);
if (![2, 8, 10, 16].includes(from) || ![2, 8, 10, 16].includes(to)) throw new Error("只支持 2/8/10/16 进制");
const s = String(value).trim().toLowerCase().replace(/^0x/, "");
if (!s || [...s].some((c) =>!"0123456789abcdef".slice(0, from).includes(c))) throw new Error(`「${value}」不是合法的 ${from} 进制数`);
return BigInt(from === 10? s: `0${from === 2? "b": from === 8? "o": "x"}${s}`).toString(to).toUpperCase();
}

export function wordCountTool(text) {
const s = String(text);
const noSpace = s.replace(/\s/g, "");
const cjk = (s.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
const words = (s.match(/[A-Za-z0-9]+/g) || []).length;
const lines = s === ""? 0: s.split(/\r?\n/).length;
return `总字符 ${s.length}（不含空白 ${noSpace.length}），汉字/假名/谚文 ${cjk} 字，英文单词 ${words} 个，共 ${lines} 行。`;
}

/* ---------------- 本地工具：换算与计算 ---------------- */

const UNIT_TABLE = {
// 类别 -> { 单位: 换算到基准单位的倍率}，温度单独处理
长度: { 米: 1, 千米: 1000, 厘米: 0.01, 毫米: 0.001, 英里: 1609.344, 英尺: 0.3048, 英寸: 0.0254, 海里: 1852, 里: 500, 丈: 10 / 3, 尺: 1 / 3, 寸: 1 / 30},
重量: { 千克: 1, 克: 0.001, 吨: 1000, 斤: 0.5, 两: 0.05, 磅: 0.45359237, 盎司: 0.0283495231},
面积: { 平方米: 1, 平方千米: 1e6, 公顷: 1e4, 亩: 2000 / 3, 平方英尺: 0.09290304, 平方厘米: 1e-4},
体积: { 升: 1, 毫升: 0.001, 立方米: 1000, 加仑: 3.785411784, 杯: 0.24},
速度: { "千米/时": 1, "米/秒": 3.6, "英里/时": 1.609344, 节: 1.852},
时间: { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400, 周: 604800},
数据: { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, Kb: 128, Mb: 131072, Gb: 134217728, B: 1, 字节: 1},
};
const TEMP_UNITS = ["摄氏度", "华氏度", "开尔文"];

export function unitConvertTool(value, from, to) {
const v = Number(value);
if (!Number.isFinite(v)) throw new Error("数值不合法");
if (TEMP_UNITS.includes(from) && TEMP_UNITS.includes(to)) {
const c = from === "摄氏度"? v: from === "华氏度"? ((v - 32) * 5) / 9: v - 273.15;
const out = to === "摄氏度"? c: to === "华氏度"? (c * 9) / 5 + 32: c + 273.15;
return `${v} ${from} = ${Number(out.toFixed(6))} ${to}`;
}
for (const [cat, table] of Object.entries(UNIT_TABLE)) {
if (from in table && to in table) {
const out = (v * table[from]) / table[to];
return `${v} ${from} = ${Number(out.toFixed(8))} ${to}（${cat}）`;
}
}
throw new Error(`不支持的单位换算：${from} → ${to}。支持长度/重量/面积/体积/速度/时间/数据/温度，单位用中文名（如 米、千克、升）或数据单位 B/KB/MB/GB。`);
}

export function dateDiffTool(dateA, dateB) {
const a = new Date(`${dateA}T00:00:00Z`);
const b = new Date(`${dateB}T00:00:00Z`);
if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Error("日期格式应为 YYYY-MM-DD");
const days = Math.round((b - a) / 86400000);
const abs = Math.abs(days);
const y = Math.floor(abs / 365);
const m = Math.floor((abs % 365) / 30);
const d = abs % 30;
const parts = [y? `${y} 年`: "", m? `${m} 个月`: "", d? `${d} 天`: ""].filter(Boolean).join(" ");
return `${dateA} 到 ${dateB} 相差 ${days} 天（绝对值 ${abs} 天，约 ${parts || "0 天"}）。`;
}

export function dateAddTool(date, days) {
const a = new Date(`${date}T00:00:00Z`);
if (Number.isNaN(a.getTime())) throw new Error("日期格式应为 YYYY-MM-DD");
const n = Number(days);
if (!Number.isFinite(n)) throw new Error("天数不合法");
a.setUTCDate(a.getUTCDate() + Math.trunc(n));
return `${date} ${n >= 0? "往后": "往前"} ${Math.abs(Math.trunc(n))} 天是 ${a.toISOString().slice(0, 10)}。`;
}

export function randomTool(mode, min, max, items) {
if (mode === "pick") {
const list = (items || []).map((x) => String(x)).filter(Boolean);
if (list.length === 0) throw new Error("没有可抽的选项");
return `抽中了：${list[crypto.randomInt(list.length)]}`;
}
const lo = Math.ceil(Number(min?? 1));
const hi = Math.floor(Number(max?? 100));
if (!Number.isFinite(lo) ||!Number.isFinite(hi) || hi < lo) throw new Error("范围不合法");
return `随机数：${crypto.randomInt(lo, hi + 1)}（范围 ${lo}–${hi}）`;
}

export function passwordGenTool(length, useSymbols) {
const lower = "abcdefghijkmnopqrstuvwxyz";
const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const digits = "23456789";
const symbols = "!@#$%^&*()-_=+";
const pools = [lower, upper, digits];
if (useSymbols!== false) pools.push(symbols);
const all = pools.join("");
const len = Math.min(64, Math.max(6, Math.trunc(Number(length) || 16)));
const chars = pools.map((p) => p[crypto.randomInt(p.length)]);
while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
for (let i = chars.length - 1; i > 0; i--) {
const j = crypto.randomInt(i + 1);
[chars[i], chars[j]] = [chars[j], chars[i]];
}
return chars.join("");
}

export function colorTool(value) {
const s = String(value).trim();
let r, g, b;
const hex = s.match(/^#?([0-9a-f]{6})$/i);
const rgb = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
if (hex) {
const n = parseInt(hex[1], 16);
[r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
} else if (rgb) {
[r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
if ([r, g, b].some((x) => x > 255)) throw new Error("RGB 分量超出 0–255");
} else {
throw new Error("只认 #RRGGBB 或 rgb(r, g, b) 格式");
}
const [rn, gn, bn] = [r / 255, g / 255, b / 255];
const max = Math.max(rn, gn, bn);
const min = Math.min(rn, gn, bn);
const l = (max + min) / 2;
let h = 0;
const d = max - min;
if (d!== 0) {
const sat = l > 0.5? d / (2 - max - min): d / (max + min);
if (max === rn) h = ((gn - bn) / d + (gn < bn? 6: 0)) * 60;
else if (max === gn) h = ((bn - rn) / d + 2) * 60;
else h = ((rn - gn) / d + 4) * 60;
const hexOut = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
return `${hexOut} = rgb(${r}, ${g}, ${b}) = hsl(${Math.round(h)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`;
}
const hexOut = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
return `${hexOut} = rgb(${r}, ${g}, ${b}) = hsl(0, 0%, ${Math.round(l * 100)}%)（灰色）`;
}

/* ---------------- 本地工具：娱乐与民俗 ---------------- */

export function diceTool(expr) {
const m = String(expr || "1d6").trim().toLowerCase().match(/^(\d{1,2})d(\d{1,3})([+-]\d{1,4})?$/);
if (!m) throw new Error("骰子写法是 NdM，如 1d6、2d20、1d100+5");
const n = Math.min(20, Math.max(1, Number(m[1])));
const sides = Math.min(1000, Math.max(2, Number(m[2])));
const mod = m[3]? Number(m[3]): 0;
const rolls = Array.from({ length: n}, () => crypto.randomInt(1, sides + 1));
const total = rolls.reduce((a, b) => a + b, 0) + mod;
return `掷 ${n}d${sides}${mod? (mod > 0? `+${mod}`: `${mod}`): ""}：${rolls.join("、")}，总计 ${total}`;
}

export function coinTool(times) {
const n = Math.min(20, Math.max(1, Math.trunc(Number(times) || 1)));
const results = Array.from({ length: n}, () => (crypto.randomInt(2) === 0? "正面": "反面"));
return `抛硬币 ${n} 次：${results.join("、")}（正面 ${results.filter((x) => x === "正面").length} 次）`;
}

const LOT_LEVELS = [
{ level: "上上签", verse: "云开雾散见青天，所求之事尽皆圆。", note: "大吉，宜进取。"},
{ level: "上上签", verse: "宝剑出匣光万丈，贵人相引上云端。", note: "时机已到，放手去做。"},
{ level: "上签", verse: "春风得意马蹄疾，一日看尽长安花。", note: "顺遂，但别得意忘形。"},
{ level: "上签", verse: "久旱逢甘雨，他乡遇故知。", note: "会有意外的帮助。"},
{ level: "中签", verse: "行到水穷处，坐看云起时。", note: "平顺，宜静观其变。"},
{ level: "中签", verse: "守得云开见月明，功夫不负有心人。", note: "坚持会有结果。"},
{ level: "中签", verse: "半途莫言弃，柳暗又一村。", note: "中途别放弃。"},
{ level: "下签", verse: "风雨欲来楼欲摧，暂避锋芒莫强为。", note: "近期宜低调，缓一缓。"},
{ level: "下签", verse: "逆水行舟力未逮，退一步来海天宽。", note: "换条路走，不必硬扛。"},
{ level: "上签", verse: "金鳞岂是池中物，一遇风云便化龙。", note: "机会将至，先备好自己。"},
{ level: "中签", verse: "但行好事，莫问前程。", note: "照常做事，结果随缘。"},
{ level: "上上签", verse: "时来天地皆同力，所愿皆成不用疑。", note: "难得的好运，抓紧办大事。"},
];

/**
 * 裸工具命令直达（v0.9.18）：消息基本就是一句娱乐工具口令时（掷骰子/塔罗牌/抽签/
 * 抛硬币），返回要执行的工具与参数，由 handlers 直接执行、一条消息发结果，不经
 * 模型裁量——经模型时它常先解释一通、发链接、反问要不要抽，体验差（对齐原项目
 * 机器人即问即抽）。带具体问法（「塔罗牌怎么玩」「我想掷骰子」）不命中、照常走模型。
 */
export function directToolCommand(question) {
const q = String(question || "").trim().replace(/[。！!？?~～、\s]+$/u, "");
let m;
if ((m = q.match(/^(?:掷|扔|摇|丢)?骰子(?:\s*(\d{1,2}d\d{1,3}(?:[+-]\d{1,4})?))?$/u))) {
return { name: "roll_dice", args: { expr: m[1] || "1d6" } };
}
if (/^(?:抽)?塔罗(?:牌)?(?:占卜)?$/u.test(q) || q === "抽牌") return { name: "tarot", args: {} };
if (/^(?:抽签|求签)$/u.test(q)) return { name: "draw_lot", args: {} };
if ((m = q.match(/^(?:抛|掷)硬币(?:\s*(\d{1,2})\s*(?:次|个|枚)?)?$/u))) {
return { name: "flip_coin", args: { times: m[1]? Number(m[1]): 1 } };
}
return null;
}

export function drawLotTool() {
const lot = LOT_LEVELS[crypto.randomInt(LOT_LEVELS.length)];
return `抽签结果：${lot.level}。签诗：${lot.verse}解曰：${lot.note}`;
}

const TAROT_MAJORS = [
["愚者", "新的开始、自由、冒险", "鲁莽、冲动、计划落空"], ["魔术师", "创造力、资源齐备、行动力", "犹豫、才能被浪费"],
["女祭司", "直觉、潜意识、静观", "忽视直觉、秘密未明"], ["皇后", "丰盛、滋养、创造力", "过度依赖、停滞"],
["皇帝", "秩序、权威、稳定", "僵化、控制欲过强"], ["教皇", "传统、指引、信念", "打破常规、质疑权威"],
["恋人", "选择、结合、价值观", "犹豫不决、关系失衡"], ["战车", "意志、胜利、推进", "失控、方向不明"],
["力量", "耐心、柔克刚、自律", "自我怀疑、精力耗尽"], ["隐者", "独处、内省、寻找答案", "孤僻、逃避"],
["命运之轮", "转机、运气、周期", "时运不济、抗拒变化"], ["正义", "公平、因果、诚实", "偏颇、逃避责任"],
["倒吊人", "换个角度、等待、放下", "无谓牺牲、拖延"], ["死神", "结束与新生、断舍离", "抗拒改变、停滞"],
["节制", "平衡、调和、耐心", "失衡、过度"], ["恶魔", "欲望、束缚、执念", "挣脱束缚、觉醒"],
["高塔", "突变、打破旧局", "拖延必然的改变"], ["星星", "希望、疗愈、灵感", "信心不足"],
["月亮", "不安、潜意识、迷雾", "迷雾散去、真相浮现"], ["太阳", "成功、喜悦、活力", "短暂的低落"],
["审判", "觉醒、召唤、复盘", "自我怀疑、错过信号"], ["世界", "圆满、完成、新阶段", "差临门一脚"],
];
const TAROT_SUITS = [
["权杖", "行动与热情"], ["圣杯", "情感与关系"], ["宝剑", "思考与冲突"], ["钱币", "现实与资源"],
];
const TAROT_RANKS = [
["王牌", "新的契机"], ["二", "抉择与平衡"], ["三", "初步成果"], ["四", "稳定与休整"], ["五", "摩擦与挑战"],
["六", "过渡与收获"], ["七", "评估与坚持"], ["八", "推进与变化"], ["九", "临近完成"], ["十", "一个阶段的终点"],
["侍从", "消息与尝试"], ["骑士", "行动与追求"], ["王后", "成熟与滋养"], ["国王", "掌控与成就"],
];

export function tarotTool(count) {
const n = Math.min(5, Math.max(1, Math.trunc(Number(count) || 1)));
const deck = [...TAROT_MAJORS.map(([name, up, rev]) => ({ name, up, rev}))];
for (const [suit, theme] of TAROT_SUITS) {
for (const [rank, rtheme] of TAROT_RANKS) {
deck.push({ name: `${suit}${rank}`, up: `${theme}：${rtheme}，势头向好`, rev: `${theme}：${rtheme}受阻，需要调整`});
}
}
const picked = [];
const used = new Set();
while (picked.length < n) {
const i = crypto.randomInt(deck.length);
if (used.has(i)) continue;
used.add(i);
const card = deck[i];
const reversed = crypto.randomInt(4) === 0;
picked.push(`${card.name}（${reversed? "逆位": "正位"}）：${reversed? card.rev: card.up}`);
}
const labels = n === 3? ["过去/现状：", "现在/核心：", "未来/走向："]: null;
return picked.map((p, i) => (labels? labels[i]: `${i + 1}. `) + p).join("\n") + "\n（塔罗仅供娱乐，别当决策依据。）";
}

const ZODIAC = [
["水瓶座", "1月20日–2月18日"], ["双鱼座", "2月19日–3月20日"], ["白羊座", "3月21日–4月19日"], ["金牛座", "4月20日–5月20日"],
["双子座", "5月21日–6月21日"], ["巨蟹座", "6月22日–7月22日"], ["狮子座", "7月23日–8月22日"], ["处女座", "8月23日–9月22日"],
["天秤座", "9月23日–10月23日"], ["天蝎座", "10月24日–11月22日"], ["射手座", "11月23日–12月21日"], ["摩羯座", "12月22日–1月19日"],
];
const FORTUNE_LINES = [
"适合把拖了很久的小事收尾。", "花钱前先冷静十分钟。", "会收到一条意外的好消息。", "今天宜早睡，状态决定一切。",
"适合主动联系一位老朋友。", "工作上别抢话，听完再说。", "适合尝试一个小的新习惯。", "贵人运不错，开口求助不丢人。",
"注意饮食，别拿胃开玩笑。", "灵感在线，想法先记下来。", "适合整理房间和文件。", "感情里多一点耐心。",
];

export function horoscopeTool(sign, timezone) {
const found = ZODIAC.find(([name]) => String(sign || "").includes(name.slice(0, 2)));
if (!found) throw new Error(`不认识的星座：${sign}。十二星座：${ZODIAC.map(([n]) => n).join("、")}`);
const today = todayInTz(timezone || "Asia/Shanghai");
const rnd = seededRandom(hashSeed(found[0] + today));
const score = () => 55 + Math.floor(rnd() * 45);
const colors = ["红色", "蓝色", "白色", "黑色", "绿色", "黄色", "紫色", "橙色", "粉色", "灰色"];
return `${found[0]}（${found[1]}）${today} 运势：综合 ${score()} 分，感情 ${score()} 分，事业 ${score()} 分，财运 ${score()} 分。幸运色 ${colors[Math.floor(rnd() * colors.length)]}，幸运数字 ${Math.floor(rnd() * 9) + 1}。今日提示：${FORTUNE_LINES[Math.floor(rnd() * FORTUNE_LINES.length)]}（运势仅供娱乐。）`;
}

const STEMS = "甲乙丙丁戊己庚辛壬癸";
const BRANCHES = "子丑寅卯辰巳午未申酉戌亥";
const ANIMALS = "鼠牛虎兔龙蛇马羊猴鸡狗猪";

export function almanacTool(timezone) {
const tz = timezone || "Asia/Shanghai";
const now = new Date();
const today = todayInTz(tz, now);
const [y, m, d] = today.split("-").map(Number);
// 农历与干支年：用 Intl 的中国农历格式化结果解析（Node full-icu 自带）。
let lunarText = "";
let ganzhiYear = "";
try {
const s = new Intl.DateTimeFormat("zh-Hans-CN-u-ca-chinese", { timeZone: tz, year: "numeric", month: "long", day: "numeric"}).format(now);
const mm = s.match(/年(.+?)月(\d+)/);
const ym = s.match(/(\d{4})(.{2})年/);
if (ym) ganzhiYear = ym[2];
if (mm) lunarText = `农历${mm[1]}月${Number(mm[2])}日`;
} catch {
lunarText = "";
}
if (!ganzhiYear) {
// 兜底：干支年按公历年粗算（春节前会有偏差，仅兜底）。
ganzhiYear = STEMS[(y - 4) % 10] + BRANCHES[(y - 4) % 12];
}
const animal = ANIMALS[BRANCHES.indexOf(ganzhiYear[1])] || "";
// 干支日：儒略日数公式，锚点 2000-01-01 = 戊午日（已核对）。
const jdn = Math.floor(Date.UTC(y, m - 1, d) / 86400000) + 2440588;
const dayIdx = (((jdn + 49) % 60) + 60) % 60;
const ganzhiDay = STEMS[dayIdx % 10] + BRANCHES[dayIdx % 12];
const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, weekday: "long"}).format(now);
return `${today}（${weekday}）：${lunarText || "农历未知"}，${ganzhiYear}年（${animal}年），今日干支 ${ganzhiDay} 日。`;
}

/* ---------------- 联网工具 ---------------- */

const WMO_TEXT = {
  0: "晴", 1: "多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨",
  56: "冻雨", 57: "冻雨", 61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪",
  75: "大雪", 77: "雪粒", 80: "阵雨", 81: "阵雨", 82: "暴雨", 85: "阵雪", 86: "阵雪", 95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "雷阵雨伴冰雹",
};

/**
 * 地理编码：先 Open-Meteo，但它的中文索引有缺口（实测「宜春」查不到、只有拼音条目 Yichun，
 * 「南昌」「伊春」却有），查不到时用 OSM 的 Photon 兜底（中文地名覆盖全；Nominatim 公共实例
 * 限流太严，实测直接 429，不用）。Photon 结果优先挑城市类条目，其次才用行政区中心点。
 */
async function geocodeCity(name) {
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`);
  const place = geo && geo.results && geo.results[0];
  if (place) {
    return { latitude: place.latitude, longitude: place.longitude, label: `${place.name}（${place.country || ""}）`, timezone: place.timezone };
  }
  const ph = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&limit=5`);
  const feats = (ph && ph.features) || [];
  if (!feats.length) return null;
  const hit = feats.find((f) => f.properties && (f.properties.type === "city" || f.properties.type === "town")) || feats[0];
  const coords = (hit.geometry && hit.geometry.coordinates) || [];
  if (typeof coords[0] !== "number" || typeof coords[1] !== "number") return null;
  const p = hit.properties || {};
  const label = [p.name, p.state].filter(Boolean).join(" ") || name;
  return { latitude: coords[1], longitude: coords[0], label, timezone: "auto" };
}

/**
 * wttr.in 兜底天气：它自己解析中文地名（背后 WorldWeatherOnline 数据），两个地理编码都查不到时
 * 直接用它出完整天气。返回与 Open-Meteo 路径同形状的文本；查不到返回 null。
 */
// wttr.in 的 j1 描述不跟 lang 参数走、只给英文，自己映射常见值（有限集合）。
const WTTR_DESC_ZH = {
  Sunny: "晴", Clear: "晴", "Partly cloudy": "多云", "Partly Cloudy": "多云", Cloudy: "阴", Overcast: "阴",
  Mist: "雾", Fog: "雾", "Freezing fog": "冻雾", "Light rain": "小雨", "Moderate rain": "中雨", "Heavy rain": "大雨",
  "Light rain shower": "阵雨", "Moderate or heavy rain shower": "阵雨", "Torrential rain shower": "暴雨",
  "Patchy rain possible": "局部有雨", "Patchy light rain": "局部小雨", "Light drizzle": "毛毛雨",
  "Light snow": "小雪", "Moderate snow": "中雪", "Heavy snow": "大雪", "Light snow showers": "阵雪",
  "Thundery outbreaks possible": "可能有雷雨", "Patchy light rain with thunder": "局部雷阵雨",
  "Moderate or heavy rain with thunder": "雷阵雨", Snow: "雪", Rain: "雨",
};

export async function wttrWeatherTool(city) {
  const data = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`);
  const cur = data && data.current_condition && data.current_condition[0];
  if (!cur) return null;
  const area = (data.nearest_area && data.nearest_area[0]) || {};
  const pick = (arr) => (Array.isArray(arr) && arr[0] && arr[0].value) || "";
  const zhDesc = (raw) => WTTR_DESC_ZH[String(raw || "").trim()] || String(raw || "").trim() || "未知";
  // 地名以用户问的为准：wttr 的 nearest_area 常给附近小站名（实测问宜春回 Wanghua），只借它的省份作注。
  const region = pick(area.region);
  const label = region && /[一-鿿]/.test(region) && !String(city).includes(region) ? `${city}（${region}）` : String(city);
  const desc = zhDesc(pick(cur.weatherDesc));
  const lines = [`${label}当前：${desc}，${cur.temp_C}°C，湿度 ${cur.humidity}%，风速 ${cur.windspeedKmph} km/h。`];
  for (const day of (data.weather || []).slice(0, 3)) {
    const mid = (day.hourly || [])[4] || (day.hourly || [])[0] || {};
    const d = mid.weatherDesc ? zhDesc(pick(mid.weatherDesc)) : "";
    lines.push(`${day.date}：${d ? `${d}，` : ""}${day.mintempC}–${day.maxtempC}°C`);
  }
  return lines.join("\n");
}

export async function weatherTool(city) {
  const name = String(city || "").trim();
  if (!name) throw new Error("要给城市名");
  const place = await geocodeCity(name);
  if (!place) {
    // 两个地理编码都查不到：最后一层用 wttr.in（自己能解析中文地名）。
    const fallback = await wttrWeatherTool(name).catch(() => null);
    if (fallback) return fallback;
    throw new Error(`找不到城市：${name}`);
  }
  const tz = encodeURIComponent(place.timezone || "auto");
  const fc = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=${tz}&forecast_days=3`,
  );
  const cur = fc.current || {};
  const daily = fc.daily || {};
  const lines = [
    `${place.label}当前：${WMO_TEXT[cur.weather_code] || "未知"}，${cur.temperature_2m}°C，湿度 ${cur.relative_humidity_2m}%，风速 ${cur.wind_speed_10m} km/h。`,
  ];
  for (let i = 0; i < (daily.time || []).length; i++) {
    lines.push(`${daily.time[i]}：${WMO_TEXT[daily.weather_code[i]] || ""}，${daily.temperature_2m_min[i]}–${daily.temperature_2m_max[i]}°C`);
  }
  return lines.join("\n");
}

function detectLang(text) {
  const s = String(text);
  if (/[぀-ヿ]/.test(s)) return "ja";
  if (/[가-힯]/.test(s)) return "ko";
  if (/[一-鿿]/.test(s)) return "zh-CN";
  if (/[Ѐ-ӿ]/.test(s)) return "ru";
  return "en";
}

export async function translateTool(text, target, source) {
  const src = source || detectLang(text);
  const tgt = target || (src === "zh-CN" ? "en" : "zh-CN");
  if (src === tgt) return `原文已是目标语言：${text}`;
  try {
    const data = await fetchJson(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(String(text).slice(0, 450))}&langpair=${encodeURIComponent(src)}%7C${encodeURIComponent(tgt)}`,
    );
    const out = data && data.responseData && data.responseData.translatedText;
    if (!out || /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(out)) throw new Error("翻译接口配额或异常");
    return out;
  } catch {
    // 接口挂了不硬编：把原文交回给模型自行翻译（工具结果里说明）。
    return `（翻译接口暂时不可用，请你直接自行把下面这段原文翻译成 ${tgt} 再回复用户，不要提及工具失败。）\n原文：${text}`;
  }
}

export async function hotListTool(source) {
  const src = String(source || "baidu").toLowerCase();
  if (src === "baidu") {
    const data = await fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime");
    const items = [];
    const walk = (o) => {
      if (!o || typeof o !== "object" || items.length >= 15) return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (typeof o.word === "string" && o.word) items.push(o.word);
      if (typeof o.query === "string" && o.query && o.url) items.push(o.query);
      Object.values(o).forEach(walk);
    };
    walk(data && data.data);
    const uniq = [...new Set(items)].slice(0, 15);
    if (!uniq.length) throw new Error("百度热搜数据解析失败");
    return `百度热搜：\n${uniq.map((w, i) => `${i + 1}. ${w}`).join("\n")}`;
  }
  if (src === "douyin") {
    const data = await fetchJson("https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/");
    const list = (data && data.word_list) || [];
    if (!list.length) throw new Error("抖音热榜数据为空");
    return `抖音热榜：\n${list.slice(0, 15).map((x, i) => `${i + 1}. ${x.word}（热度 ${x.hot_value}）`).join("\n")}`;
  }
  if (src === "bilibili") {
    const data = await fetchJson("https://api.bilibili.com/x/web-interface/popular?ps=15&pn=1");
    const list = (data && data.data && data.data.list) || [];
    if (!list.length) throw new Error("B站热门数据为空");
    return `B站热门：\n${list.map((v, i) => `${i + 1}. 《${v.title}》UP主 ${v.owner && v.owner.name}，播放 ${v.stat && v.stat.view}`).join("\n")}`;
  }
  if (src === "weibo") {
    const data = await fetchJson("https://weibo.com/ajax/side/hotSearch", { headers: { Referer: "https://weibo.com/" } });
    const list = (data && data.data && data.data.realtime) || [];
    if (!list.length) throw new Error("微博热搜接口暂时不可用（返回为空，多为接口风控）");
    return `微博热搜：\n${list.slice(0, 15).map((x, i) => `${i + 1}. ${x.word}`).join("\n")}`;
  }
  throw new Error("热榜来源只支持 baidu / weibo / douyin / bilibili");
}

export async function githubSearchTool(query) {
  const data = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(String(query))}&per_page=8&sort=stars&order=desc`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  const items = (data && data.items) || [];
  if (!items.length) return `GitHub 上没找到与「${query}」相关的仓库。`;
  return items
    .map((r, i) => `${i + 1}. ${r.full_name}（★${r.stargazers_count}${r.language ? `，${r.language}` : ""}）：${(r.description || "无简介").slice(0, 80)}\n${r.html_url}`)
    .join("\n");
}

async function erRates(base) {
  const data = await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
  if (!data || data.result !== "success" || !data.rates) throw new Error("汇率接口异常");
  return data.rates;
}

export async function exchangeRateTool(from, to, amount) {
  const f = String(from || "USD").toUpperCase();
  const t = String(to || "CNY").toUpperCase();
  const rates = await erRates(f);
  const rate = rates[t];
  if (!rate) throw new Error(`不支持的币种：${f} 或 ${t}（用 USD、CNY、JPY、EUR 这类三字母代码）`);
  const amt = Number(amount);
  if (Number.isFinite(amt) && amt > 0) return `${amt} ${f} = ${(amt * rate).toFixed(4)} ${t}（汇率 1 ${f} = ${rate} ${t}，数据为当日参考汇率）`;
  return `1 ${f} = ${rate} ${t}（当日参考汇率）`;
}

const COIN_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", DOGE: "dogecoin", XRP: "ripple", BNB: "binancecoin",
  ADA: "cardano", TON: "the-open-network", TRX: "tron", LTC: "litecoin", DOT: "polkadot", AVAX: "avalanche-2",
  USDT: "tether", USDC: "usd-coin", PEPE: "pepe", SHIB: "shiba-inu", NEAR: "near", APT: "aptos", ARB: "arbitrum", OP: "optimism",
};

export async function cryptoPriceTool(coins) {
  const symbols = String(coins || "BTC").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 6);
  const ids = symbols.map((s) => COIN_IDS[s]).filter(Boolean);
  if (!ids.length) throw new Error(`不认识的币种：${coins}。支持：${Object.keys(COIN_IDS).join("、")}`);
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd,cny&include_24hr_change=true`,
  );
  const lines = symbols
    .filter((s) => data[COIN_IDS[s]])
    .map((s) => {
      const p = data[COIN_IDS[s]];
      const chg = typeof p.usd_24h_change === "number" ? `，24h ${p.usd_24h_change >= 0 ? "+" : ""}${p.usd_24h_change.toFixed(2)}%` : "";
      return `${s}：$${p.usd}（¥${p.cny}）${chg}`;
    });
  if (!lines.length) throw new Error("币价接口没有返回数据");
  return lines.join("\n") + "\n（数据来自 CoinGecko，仅供参考）";
}

export async function goldPriceTool() {
  const [xau, xag, rates] = await Promise.all([
    fetchJson("https://api.gold-api.com/price/XAU"),
    fetchJson("https://api.gold-api.com/price/XAG").catch(() => null),
    erRates("USD").catch(() => null),
  ]);
  if (!xau || typeof xau.price !== "number") throw new Error("金价接口异常");
  const cnyPerOz = rates && rates.CNY ? xau.price * rates.CNY : null;
  const lines = [`黄金（XAU）：$${xau.price}/盎司${cnyPerOz ? `，约 ¥${(cnyPerOz / 31.1035).toFixed(2)}/克` : ""}。`];
  if (xag && typeof xag.price === "number") lines.push(`白银（XAG）：$${xag.price}/盎司。`);
  lines.push("（国际现货价，仅供参考）");
  return lines.join("\n");
}

// 股票/指数行情（v0.9.9）：搜索摘要里没有具体价格，这类问题走行情接口。
// 主源 Yahoo Finance chart API（免 key），美股/指数另有腾讯行情兜底。
const STOCK_ALIASES = {
"标普500": ["^GSPC", "标普500指数"], "标普": ["^GSPC", "标普500指数"], "SPX": ["^GSPC", "标普500指数"],
"S&P500": ["^GSPC", "标普500指数"], "S&P 500": ["^GSPC", "标普500指数"], "SP500": ["^GSPC", "标普500指数"],
"道琼斯": ["^DJI", "道琼斯工业指数"], "道指": ["^DJI", "道琼斯工业指数"], "DJI": ["^DJI", "道琼斯工业指数"],
"纳斯达克": ["^IXIC", "纳斯达克综合指数"], "纳指": ["^IXIC", "纳斯达克综合指数"], "纳斯达克综合": ["^IXIC", "纳斯达克综合指数"],
"纳指100": ["^NDX", "纳斯达克100指数"], "纳斯达克100": ["^NDX", "纳斯达克100指数"],
"恒生": ["^HSI", "恒生指数"], "恒生指数": ["^HSI", "恒生指数"], "恒指": ["^HSI", "恒生指数"],
"日经": ["^N225", "日经225指数"], "日经225": ["^N225", "日经225指数"],
"上证": ["000001.SS", "上证指数"], "上证指数": ["000001.SS", "上证指数"],
"深证成指": ["399001.SZ", "深证成指"], "创业板指": ["399006.SZ", "创业板指"],
"沪深300": ["000300.SS", "沪深300指数"], "科创50": ["000688.SS", "科创50指数"],
"英伟达": ["NVDA", "英伟达"], "苹果": ["AAPL", "苹果"], "特斯拉": ["TSLA", "特斯拉"],
"微软": ["MSFT", "微软"], "谷歌": ["GOOGL", "谷歌"], "亚马逊": ["AMZN", "亚马逊"],
"脸书": ["META", "Meta"], "台积电": ["TSM", "台积电"], "博通": ["AVGO", "博通"],
"阿里巴巴": ["BABA", "阿里巴巴"], "腾讯": ["0700.HK", "腾讯控股"], "美团": ["3690.HK", "美团"],
"小米": ["1810.HK", "小米集团"], "比亚迪": ["1211.HK", "比亚迪股份"],
"茅台": ["600519.SS", "贵州茅台"], "贵州茅台": ["600519.SS", "贵州茅台"], "宁德时代": ["300750.SZ", "宁德时代"],
};

/** 把用户说的名字/代码解析成 Yahoo 代码；不认识返回 null。 */
export function resolveStockSymbol(input) {
const raw = String(input || "").replace(/\s+/g, " ").trim();
if (!raw) return null;
const stripped = raw.replace(/(股票|指数|收盘价|股价|行情)+$/g, "").trim();
for (const key of [raw, raw.toUpperCase(), stripped, stripped.toUpperCase()]) {
if (key && STOCK_ALIASES[key]) return { symbol: STOCK_ALIASES[key][0], name: STOCK_ALIASES[key][1] };
}
const upper = raw.toUpperCase();
if (/^[A-Z0-9.^=-]{1,15}$/.test(upper) && /[A-Z]/.test(upper)) return { symbol: upper, name: upper };
return null;
}

/** 解析 Yahoo chart API 返回，取最后一根有收盘价的日线与前一根。 */
export function parseYahooChart(data) {
const r = data && data.chart && Array.isArray(data.chart.result) ? data.chart.result[0] : null;
if (!r) return null;
const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
const closes = q.close || [];
let last = -1;
for (let i = closes.length - 1; i >= 0; i--) if (typeof closes[i] === "number") { last = i; break; }
if (last < 0) return null;
let prev = -1;
for (let i = last - 1; i >= 0; i--) if (typeof closes[i] === "number") { prev = i; break; }
const meta = r.meta || {};
let date = "";
const ts = (r.timestamp || [])[last];
if (ts) {
try {
date = new Intl.DateTimeFormat("en-CA", { timeZone: meta.exchangeTimezoneName || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));
} catch {
date = new Date(ts * 1000).toISOString().slice(0, 10);
}
}
return {
close: closes[last],
prevClose: prev >= 0 ? closes[prev] : (typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : null),
open: q.open && typeof q.open[last] === "number" ? q.open[last] : null,
high: q.high && typeof q.high[last] === "number" ? q.high[last] : null,
low: q.low && typeof q.low[last] === "number" ? q.low[last] : null,
date, currency: meta.currency || "",
};
}

function tencentCodeFor(symbol) {
const map = { "^GSPC": "usINX", "^DJI": "usDJI", "^IXIC": "usIXIC", "^NDX": "usNDX" };
if (map[symbol]) return map[symbol];
if (/^[A-Z]{1,5}$/.test(symbol)) return `us${symbol}`;
return null;
}

/** 解析腾讯行情（qt.gtimg.cn）的 ~ 分隔文本；只取数字字段，不依赖名称编码。 */
export function parseTencentQuote(text) {
const m = String(text || "").match(/="([^"]*)"/);
if (!m) return null;
const f = m[1].split("~");
const num = (v) => {
const n = Number(v);
return Number.isFinite(n) ? n : null;
};
const close = num(f[3]);
if (close === null) return null;
const dtIdx = f.findIndex((x) => /^\d{4}-\d{2}-\d{2}/.test(x));
return {
close,
prevClose: num(f[4]),
open: num(f[5]),
date: dtIdx >= 0 ? f[dtIdx].slice(0, 10) : "",
change: dtIdx >= 0 ? num(f[dtIdx + 1]) : null,
pct: dtIdx >= 0 ? num(f[dtIdx + 2]) : null,
high: dtIdx >= 0 ? num(f[dtIdx + 3]) : null,
low: dtIdx >= 0 ? num(f[dtIdx + 4]) : null,
currency: "USD",
};
}

export async function stockQuoteTool(query) {
const resolved = resolveStockSymbol(query);
if (!resolved) {
throw new Error(`不认识的股票/指数：${query}。可以问标普500、道琼斯、纳斯达克、恒生、上证，或英伟达、苹果、特斯拉等，也可以直接给代码如 NVDA、^GSPC、0700.HK。`);
}
const { symbol, name } = resolved;
let q = null;
let source = "Yahoo Finance";
try {
const data = await fetchJson(
`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
{ headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } },
);
q = parseYahooChart(data);
} catch {
q = null;
}
if (!q) {
const tc = tencentCodeFor(symbol);
if (tc) {
try {
const res = await fetchWithTimeout(`https://qt.gtimg.cn/q=${tc}`);
if (res.ok) {
q = parseTencentQuote(await res.text());
if (q) source = "腾讯行情";
}
} catch {
q = null;
}
}
}
if (!q) throw new Error(`行情接口暂时没返回 ${name} 的数据，稍后再试。`);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null);
let chg = typeof q.change === "number" ? q.change : null;
let pct = typeof q.pct === "number" ? q.pct : null;
if (chg === null && typeof q.prevClose === "number" && q.prevClose) {
chg = q.close - q.prevClose;
pct = (chg / q.prevClose) * 100;
}
const lines = [`${name}（${symbol}）`, `收盘：${fmt(q.close)}${q.currency ? ` ${q.currency}` : ""}${q.date ? `（${q.date}）` : ""}`];
if (chg !== null && pct !== null) {
lines.push(`涨跌：${chg >= 0 ? "+" : ""}${fmt(chg)}（${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%）${typeof q.prevClose === "number" ? `，前收 ${fmt(q.prevClose)}` : ""}`);
}
if (q.open !== null || q.high !== null || q.low !== null) {
lines.push(`开 ${fmt(q.open) ?? "-"}｜高 ${fmt(q.high) ?? "-"}｜低 ${fmt(q.low) ?? "-"}`);
}
lines.push(`（数据来自 ${source}，仅供参考）`);
return lines.join("\n");
}

export async function oilPriceTool() {
  // 国内油价免费源（oioweb）：部分网络不可达，拿不到就如实说。
  const data = await fetchJson("https://api.oioweb.cn/api/common/oil");
  const result = data && (data.result || data.data);
  if (!result) throw new Error("国内油价数据源暂时不可用");
  const rows = Array.isArray(result) ? result : [result];
  const lines = rows.slice(0, 12).map((r) => {
    const name = r.name || r.province || r.city || "";
    const p92 = r.p92 ?? r["92h"] ?? r.oil92 ?? "";
    const p95 = r.p95 ?? r["95h"] ?? r.oil95 ?? "";
    const p0 = r.p0 ?? r.oil0 ?? "";
    return `${name}：92号 ${p92}，95号 ${p95}，0号柴油 ${p0}`;
  });
  return `国内油价（元/升）：\n${lines.join("\n")}`;
}

export async function boxOfficeTool() {
  // 猫眼实时票房（second.json）：接口常有风控，解析不到就如实回报。
  const data = await fetchJson("https://box.maoyan.com/promovie/api/box/second.json", { headers: { Referer: "https://box.maoyan.com/" } });
  const list = data && data.data && (data.data.list || data.data.boxList);
  if (!Array.isArray(list) || !list.length) throw new Error("猫眼票房接口暂时不可用（多为接口风控）");
  return `今日电影票房：\n${list.slice(0, 10).map((m, i) => `${i + 1}. 《${m.movieName || m.name}》票房 ${m.sumBoxInfo || m.boxInfo || m.sumBoxDesc || ""}`).join("\n")}`;
}

export async function doubanMoviesTool(mode, query) {
  if (mode === "search" && query) {
    const data = await fetchJson(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(String(query))}`, {
      headers: { Referer: "https://movie.douban.com/" },
    });
    const items = Array.isArray(data) ? data : [];
    if (!items.length) return `豆瓣上没找到「${query}」。`;
    return items.slice(0, 8).map((m, i) => `${i + 1}. 《${m.title}》（${m.year || ""}${m.sub_title ? `，${m.sub_title}` : ""}）${m.url}`).join("\n");
  }
  const data = await fetchJson("https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&page_limit=12&page_start=0", {
    headers: { Referer: "https://movie.douban.com/" },
  });
  const items = (data && data.subjects) || [];
  if (!items.length) throw new Error("豆瓣热门数据为空");
  return `豆瓣热门电影：\n${items.map((m, i) => `${i + 1}. 《${m.title}》评分 ${m.rate || "暂无"} ${m.url}`).join("\n")}`;
}

export async function wikiTool(query, source) {
  const q = String(query || "").trim();
  if (!q) throw new Error("要给查询词");
  const src = String(source || "wikipedia").toLowerCase();
  if (src === "wikidata") {
    const data = await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=zh&uselang=zh&format=json&limit=5`,
    );
    const items = (data && data.search) || [];
    if (!items.length) return `维基数据里没找到「${q}」。`;
    return items.map((e, i) => `${i + 1}. ${e.label || e.id}（${e.id}）：${e.description || "无描述"}`).join("\n");
  }
  if (src === "duckduckgo") {
    const data = await fetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    const parts = [];
    if (data && data.Answer) parts.push(`答案：${data.Answer}`);
    if (data && data.AbstractText) parts.push(`${data.AbstractText}（来源：${data.AbstractSource || "DuckDuckGo"}）`);
    const topics = ((data && data.RelatedTopics) || []).filter((t) => t && t.Text).slice(0, 5);
    if (topics.length) parts.push(topics.map((t, i) => `${i + 1}. ${t.Text}`).join("\n"));
    if (!parts.length) return `DuckDuckGo 没有给出「${q}」的即时答案。`;
    return parts.join("\n");
  }
  const data = await fetchJson(
    `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(q)}`,
  );
  const pages = (data && data.query && data.query.pages) || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract) return `中文维基百科里没找到词条「${q}」。`;
  return `《${page.title}》：${String(page.extract).slice(0, 1200)}`;
}

export async function ipLookupTool(ip) {
  const target = String(ip || "").trim();
  if (!target) throw new Error("要给 IP 地址");
  const data = await fetchJson(`http://ip-api.com/json/${encodeURIComponent(target)}?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,timezone,query`);
  if (!data || data.status !== "success") throw new Error(`查询失败：${(data && data.message) || "接口异常"}`);
  return `${data.query} 归属：${data.country} ${data.regionName} ${data.city}，运营商 ${data.isp}${data.org ? `（${data.org}）` : ""}，时区 ${data.timezone}，线路 ${data.as || ""}`;
}

export async function hitokotoTool() {
  const data = await fetchJson("https://v1.hitokoto.cn/?encode=json");
  if (!data || !data.hitokoto) throw new Error("一言接口异常");
  const from = data.from_who || data.from || "";
  return `「${data.hitokoto}」${from ? `——${from}${data.from ? `《${data.from}》` : ""}` : ""}`;
}

export async function poetryTool() {
  const data = await fetchJson("https://v2.jinrishici.com/one.json");
  const d = data && data.data;
  if (!d || !d.content) throw new Error("诗词接口异常");
  const origin = d.origin || {};
  return `「${d.content}」——${origin.dynasty || ""}·${origin.author || ""}《${origin.title || ""}》`;
}

export async function bookSearchTool(title) {
  const data = await fetchJson(`https://openlibrary.org/search.json?title=${encodeURIComponent(String(title))}&limit=6&fields=title,author_name,first_publish_year,publisher,isbn`);
  const docs = (data && data.docs) || [];
  if (!docs.length) return `Open Library 里没找到《${title}》。`;
  return docs
    .map((b, i) => `${i + 1}. 《${b.title}》作者 ${(b.author_name || ["未知"]).join("、")}，首版 ${b.first_publish_year || "未知"}${b.isbn && b.isbn[0] ? `，ISBN ${b.isbn[0]}` : ""}`)
    .join("\n");
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1)/i;

export async function expandUrlTool(url) {
  let current = String(url || "").trim();
  if (!/^https?:\/\//i.test(current)) throw new Error("只支持 http/https 链接");
  const chain = [current];
  for (let hop = 0; hop < 10; hop++) {
    let host = "";
    try {
      host = new URL(current).hostname;
    } catch {
      throw new Error("链接格式不对");
    }
    if (PRIVATE_HOST_RE.test(host)) throw new Error("内网地址不展开");
    const res = await fetchWithTimeout(current, { method: "GET", redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      chain.push(current);
      continue;
    }
    return `最终地址：${current}（共跳转 ${chain.length - 1} 次，状态 ${res.status}）`;
  }
  return `跳转次数过多，最后停在：${current}`;
}

export async function qrcodeTool(text, ctx) {
  const content = String(text || "").trim();
  if (!content) throw new Error("要给二维码内容（文字或链接）");
  const res = await fetchWithTimeout(`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(content.slice(0, 500))}`);
  if (!res.ok) throw new Error(`二维码接口 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (ctx && Array.isArray(ctx.outbox)) ctx.outbox.push({ type: "photo", buffer: buf, filename: "qrcode.png" });
  return `二维码已生成（内容：${content.slice(0, 80)}），图片会随回复一起发出去。`;
}

/**
 * 搜图发图（v0.9.14）：用户想看某个人物/东西的照片时，handlers 注入的 ctx.imageSearch
 * （Yahoo 图片搜索，返回原图地址列表）找图，这里逐个下载、验 content-type 与体积，
 * 第一张合格的推进 outbox 随回复发出。通道未启用/没搜到/全下载失败时返回说明文字，
 * 让模型如实回话，不编图。
 */
export async function findPhotoTool(query, ctx) {
  const q = String(query || "").trim();
  if (!q) throw new Error("要给搜图关键词");
  if (!ctx || typeof ctx.imageSearch !== "function") return "搜图通道未启用，这边发不了图。";
  const urls = await ctx.imageSearch(q);
  if (!Array.isArray(urls) || urls.length === 0) return `没搜到「${q}」的图片。`;
  const EXT_BY_TYPE = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
  for (const url of urls.slice(0, 3)) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5 * 1024 || buf.length > 15 * 1024 * 1024) continue;
      if (ctx && Array.isArray(ctx.outbox)) {
        ctx.outbox.push({ type: "photo", buffer: buf, filename: `photo${EXT_BY_TYPE[type] || ".jpg"}` });
      }
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {}
      return `已找到「${q}」的图片并附在回复里（来源：${host}）。回话时简单说一句就行，不要贴图片链接。`;
    } catch {
      // 换下一张候选。
    }
  }
  return `搜到了「${q}」的图片，但都下载失败，发不出去。`;
}

/** 生图工具：执行端由 handlers 经 ctx.imageGen 注入（选提供方、占位、生成、发图都在那边），
 * 这里只转交画面描述并原样带回结果。 */
export async function generateImageTool(prompt, ctx) {
  const p = String(prompt || "").trim();
  if (!p) throw new Error("要给画面描述");
  if (!ctx || typeof ctx.imageGen !== "function") return "生图通道未启用，这边发不了图。";
  return ctx.imageGen(p);
}

/* ---------------- 状态类工具：时间、提醒、待办 ---------------- */

const CITY_TZ = {
  北京: "Asia/Shanghai", 上海: "Asia/Shanghai", 东京: "Asia/Tokyo", 大阪: "Asia/Tokyo", 首尔: "Asia/Seoul",
  新加坡: "Asia/Singapore", 香港: "Asia/Hong_Kong", 台北: "Asia/Taipei", 伦敦: "Europe/London", 巴黎: "Europe/Paris",
  柏林: "Europe/Berlin", 莫斯科: "Europe/Moscow", 迪拜: "Asia/Dubai", 悉尼: "Australia/Sydney",
  纽约: "America/New_York", 洛杉矶: "America/Los_Angeles", 旧金山: "America/Los_Angeles", 芝加哥: "America/Chicago",
  多伦多: "America/Toronto", 温哥华: "America/Vancouver", 圣保罗: "America/Sao_Paulo", 奥克兰: "Pacific/Auckland",
};

export function worldTimeTool(place, defaultTz) {
  const p = String(place || "").trim();
  const tz = !p ? defaultTz || "Asia/Shanghai" : CITY_TZ[p] || (p.includes("/") ? p : null);
  if (!tz) throw new Error(`不认识的地方：${p}。支持主要城市中文名，或直接给 IANA 时区如 Asia/Tokyo。`);
  try {
    const s = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "shortOffset",
    }).format(new Date());
    return `${p || "本地"}（${tz}）：${s}`;
  } catch {
    throw new Error(`时区不合法：${tz}`);
  }
}

export async function addReminderTool(args, ctx) {
  if (!ctx || !ctx.store) throw new Error("提醒功能未就绪");
  // 相对时间优先走 in_seconds（代码算绝对时刻）；让模型自己换算 ISO 时间+时区
  // 极易出错（2026-11-22 实测把东京时间说成北京时间、且没调工具就编造已设好）。
  let at = null;
  const secs = Number(args && args.in_seconds);
  if (Number.isFinite(secs) && secs > 0) {
    at = new Date(Date.now() + Math.min(secs, 7 * 24 * 3600) * 1000);
  } else {
    at = new Date(args && args.at);
    if (Number.isNaN(at.getTime())) throw new Error("提醒时间格式不对：相对时间填 in_seconds（秒数），绝对时间填 ISO 时间（含时区）");
    if (at.getTime() <= Date.now()) throw new Error("提醒时间已经过了");
  }
  // 设定时就把设定者的 accessHash 捕获落盘：到点时调度器的实体缓存未必有这个人
  // （GramJS 缓存每连接一份、冷启动为空），靠它才能稳定构建出提及实体（v0.9.17）。
  // 名字缺失时也顺手用实体补一次（getSpeakerName 冷缓存会取空）。
  let senderName = String(ctx.senderName || "");
  let senderAccessHash = "";
  if (ctx.client && ctx.senderId) {
    try {
      const p = await ctx.client.getInputEntity(String(ctx.senderId));
      if (p && p.accessHash) senderAccessHash = String(p.accessHash);
    } catch {
      // 拿不到不阻塞设定：到点时调度器还有扫会话预热的兜底。
    }
    if (!senderName) {
      try {
        const u = await ctx.client.getEntity(String(ctx.senderId));
        if (u) senderName = String([u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "").trim();
      } catch {
        // 同上。
      }
    }
  }
  const item = ctx.store.addReminder({ chatId: String(ctx.chatId), senderId: String(ctx.senderId), senderName, senderAccessHash, text: String(args.text || "（无内容）"), at: at.toISOString() });
  const shown = new Intl.DateTimeFormat("zh-CN", { timeZone: ctx.timezone || "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(at);
  return `提醒已设：${shown} 提醒「${item.text}」。到点我会在这个会话里 @ 你发提醒。`;
}

export function listRemindersTool(ctx) {
  if (!ctx || !ctx.store) throw new Error("提醒功能未就绪");
  const list = ctx.store.listReminders(String(ctx.chatId));
  if (!list.length) return "这个会话还没有待触发的提醒。";
  return `待触发的提醒：\n${list.map((r, i) => `${i + 1}. ${new Intl.DateTimeFormat("zh-CN", { timeZone: ctx.timezone || "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(r.at))}：${r.text}`).join("\n")}`;
}

export function todoTool(action, text, index, ctx) {
  if (!ctx || !ctx.store) throw new Error("待办功能未就绪");
  const key = `${ctx.chatId}:${ctx.senderId}`;
  if (action === "add") {
    const list = ctx.store.addTodo(key, String(text || ""));
    return `已加进待办（第 ${list.length} 条）：${text}`;
  }
  if (action === "done") {
    const removed = ctx.store.doneTodo(key, Number(index));
    if (!removed) throw new Error("没有这个序号的待办");
    return `已完成并划掉：${removed}`;
  }
  if (action === "clear") {
    ctx.store.clearTodos(key);
    return "待办已清空。";
  }
  const list = ctx.store.listTodos(key);
  if (!list.length) return "待办清单是空的。";
  return `待办清单：\n${list.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

/* ---------------- 工具注册表 ---------------- */

const S = (props, required = []) => ({ type: "object", properties: props, required});
const STR = { type: "string"};
const NUM = { type: "number"};

/**
* 工具定义：name / description（给模型看）/ parameters（JSON Schema）/ run(args, ctx)。
* ctx = { chatId, senderId, timezone, logger, outbox, store}
*/
export const TOOL_DEFS = [
{ name: "get_weather", description: "查某个城市的实时天气和未来 3 天预报。用户问天气、气温、下不下雨时调用。", parameters: S({ city: STR}, ["city"]), run: (a) => weatherTool(a.city)},
{ name: "translate_text", description: "把一段文字翻译成另一种语言（多源自动切换）。用户要翻译时调用；target 用语言代码如 zh-CN、en、ja、ko。", parameters: S({ text: STR, target: STR, source: STR}, ["text"]), run: (a) => translateTool(a.text, a.target, a.source)},
{ name: "hot_list", description: "查热搜热榜。用户问新闻、热点、头条时也用它（默认 baidu）。source 取 baidu（百度热搜）、weibo（微博热搜）、douyin（抖音热榜）、bilibili（B站热门视频）。", parameters: S({ source: STR}, ["source"]), run: (a) => hotListTool(a.source)},
{ name: "github_search", description: "在 GitHub 上按关键词搜索仓库，返回星标靠前的结果。", parameters: S({ query: STR}, ["query"]), run: (a) => githubSearchTool(a.query)},
{ name: "exchange_rate", description: "查汇率或换算货币。币种用三字母代码（USD、CNY、JPY、EUR、GBP、HKD 等）；给了 amount 就换算金额。", parameters: S({ from: STR, to: STR, amount: NUM}, ["from", "to"]), run: (a) => exchangeRateTool(a.from, a.to, a.amount)},
{ name: "crypto_price", description: "查加密货币价格（美元+人民币+24h 涨跌）。coins 是币种符号，逗号分隔，如 BTC,ETH。", parameters: S({ coins: STR}, ["coins"]), run: (a) => cryptoPriceTool(a.coins)},
{ name: "gold_price", description: "查国际金价（和银价），含人民币每克换算。用户问金价、黄金多少钱时调用。", parameters: S({}), run: () => goldPriceTool()},
{ name: "oil_price", description: "查国内油价（各省 92/95/0 号价格）。数据源偶尔不可达，失败会如实说明。", parameters: S({}), run: () => oilPriceTool()},
{ name: "stock_quote", description: "查股票/指数行情：最新收盘价、涨跌、前收、今开、高低。symbol 填用户说的名字或代码，如 标普500、SPX、纳斯达克、恒生、上证、英伟达、NVDA、苹果、0700.HK。用户问股价、收盘价、指数点位时调用，不要用搜索结果里的链接猜价格。", parameters: S({ symbol: STR}, ["symbol"]), run: (a) => stockQuoteTool(a.symbol)},
{ name: "box_office", description: "查今日电影票房榜（猫眼数据）。接口偶尔被风控，失败会如实说明。", parameters: S({}), run: () => boxOfficeTool()},
{ name: "douban_movies", description: "豆瓣电影：mode=hot 看热门榜，mode=search 按片名搜索（给 query）。", parameters: S({ mode: STR, query: STR}, ["mode"]), run: (a) => doubanMoviesTool(a.mode, a.query)},
{ name: "wiki_lookup", description: "查百科知识。source 取 wikipedia（中文维基词条摘要）、wikidata（实体信息）、duckduckgo（即时答案）。", parameters: S({ query: STR, source: STR}, ["query"]), run: (a) => wikiTool(a.query, a.source)},
{ name: "ip_lookup", description: "查一个 IP 地址的归属地、运营商和时区。", parameters: S({ ip: STR}, ["ip"]), run: (a) => ipLookupTool(a.ip)},
{ name: "hitokoto", description: "来一句一言（随机句子）。用户想要一句话、语录、鸡汤时调用。", parameters: S({}), run: () => hitokotoTool()},
{ name: "daily_poetry", description: "来一首今日诗词（随机古诗词一句及出处）。", parameters: S({}), run: () => poetryTool()},
{ name: "book_search", description: "按书名查图书信息（作者、首版年份、ISBN）。", parameters: S({ title: STR}, ["title"]), run: (a) => bookSearchTool(a.title)},
{ name: "expand_url", description: "还原短网址，返回最终跳转地址。用户给短链接想知道指向哪时调用。", parameters: S({ url: STR}, ["url"]), run: (a) => expandUrlTool(a.url)},
{ name: "make_qrcode", description: "把文字或链接生成二维码图片，图片会随回复发出。", parameters: S({ text: STR}, ["text"]), run: (a, ctx) => qrcodeTool(a.text, ctx)},
{ name: "find_photo", description: "用户想看某个人物、角色、东西或地方的照片/图片时用（如「看看X的照片」「发张X的图」「X长什么样」「来张X的壁纸」）：按关键词全网搜图，把找到的图随回复发出去。query 填要搜的对象名，可带限定词（如「时崎狂三 立绘」）。", parameters: S({ query: STR }, ["query"]), run: (a, ctx) => findPhotoTool(a.query, ctx)},
{ name: "generate_image", description: "用户想让你现场画/生成/制作一张新图片时用（如「画一张X」「生成一张X的图片」「给我做张X的壁纸」「想要一张X的图」「生产一张X的实景照」）：按 prompt 生成一张全新的图并发到会话里。prompt 填画面描述，中文即可、尽量具体（主体、场景、风格）。注意：用户想看现成已有的照片/形象（「看看X的照片」「X长什么样」）用 find_photo，不要用这个。", parameters: S({ prompt: STR }, ["prompt"]), run: (a, ctx) => generateImageTool(a.prompt, ctx)},
{ name: "world_time", description: "查某个城市/时区的当前时间。place 给城市中文名（如 东京、纽约）或 IANA 时区；不给就是机器人时区的当前时间。", parameters: S({ place: STR}), run: (a, ctx) => worldTimeTool(a.place, ctx && ctx.timezone)},
{ name: "set_reminder", description: "设定时提醒：到点时机器人会在当前会话 @ 设定者发提醒。用户说相对时间（X 秒/分钟/小时后）时优先填 in_seconds（秒数，如 1 分钟后填 60），不要自己换算时区；用户给了绝对日期时间时才填 at（ISO 字符串带时区，如 2026-11-22T09:00:00+09:00）。text 填提醒内容。", parameters: S({ text: STR, at: STR, in_seconds: NUM }, ["text"]), run: (a, ctx) => addReminderTool(a, ctx)},
{ name: "list_reminders", description: "查看当前会话还没触发的提醒列表。", parameters: S({}), run: (a, ctx) => listRemindersTool(ctx)},
{ name: "todo", description: "待办清单（按会话+用户保存）。action 取 add（加一条，给 text）、list（查看）、done（完成一条，给 index 序号）、clear（清空）。", parameters: S({ action: STR, text: STR, index: NUM}, ["action"]), run: (a, ctx) => todoTool(a.action, a.text, a.index, ctx)},
{ name: "base64", description: "Base64 编码或解码。mode 取 encode 或 decode。", parameters: S({ text: STR, mode: STR}, ["text", "mode"]), run: (a) => base64Tool(a.text, a.mode)},
{ name: "url_codec", description: "URL 编码或解码。mode 取 encode 或 decode。", parameters: S({ text: STR, mode: STR}, ["text", "mode"]), run: (a) => urlCodecTool(a.text, a.mode)},
{ name: "morse", description: "摩斯电码编码或解码。mode 取 encode 或 decode。", parameters: S({ text: STR, mode: STR}, ["text", "mode"]), run: (a) => morseTool(a.text, a.mode)},
{ name: "hash_text", description: "计算文本的哈希值。algo 取 md5、sha1、sha256、sha512。", parameters: S({ text: STR, algo: STR}, ["text"]), run: (a) => hashTool(a.text, a.algo)},
{ name: "json_format", description: "JSON 格式化或压缩、顺带校验合法性。mode 取 format 或 minify。", parameters: S({ text: STR, mode: STR}, ["text", "mode"]), run: (a) => jsonTool(a.text, a.mode)},
{ name: "base_convert", description: "进制转换（2/8/10/16 之间）。", parameters: S({ value: STR, from_base: NUM, to_base: NUM}, ["value", "from_base", "to_base"]), run: (a) => baseConvertTool(a.value, a.from_base, a.to_base)},
{ name: "unit_convert", description: "单位换算：长度、重量、面积、体积、速度、时间、数据、温度。单位用中文名（米、千米、斤、升、摄氏度等）或 B/KB/MB/GB。", parameters: S({ value: NUM, from: STR, to: STR}, ["value", "from", "to"]), run: (a) => unitConvertTool(a.value, a.from, a.to)},
{ name: "date_diff", description: "算两个日期相差多少天。日期格式 YYYY-MM-DD。", parameters: S({ date_a: STR, date_b: STR}, ["date_a", "date_b"]), run: (a) => dateDiffTool(a.date_a, a.date_b)},
{ name: "date_add", description: "算某日期往后（或往前，days 为负）N 天是哪天。", parameters: S({ date: STR, days: NUM}, ["date", "days"]), run: (a) => dateAddTool(a.date, a.days)},
{ name: "random_number", description: "生成随机数（mode=int，给 min/max），或从候选里随机抽一个（mode=pick，给 items 数组）。", parameters: S({ mode: STR, min: NUM, max: NUM, items: { type: "array", items: STR}}, ["mode"]), run: (a) => randomTool(a.mode, a.min, a.max, a.items)},
{ name: "generate_password", description: "生成一个强随机密码。length 是长度（6–64），use_symbols 是否带符号。", parameters: S({ length: NUM, use_symbols: { type: "boolean"}}), run: (a) => passwordGenTool(a.length, a.use_symbols)},
{ name: "word_count", description: "统计一段文字的字数、词数和行数。", parameters: S({ text: STR}, ["text"]), run: (a) => wordCountTool(a.text)},
{ name: "color_convert", description: "颜色格式换算：输入 #RRGGBB 或 rgb(r,g,b)，输出 HEX/RGB/HSL。", parameters: S({ value: STR}, ["value"]), run: (a) => colorTool(a.value)},
{ name: "roll_dice", description: "掷骰子，表达式如 1d6、2d20、1d100+5。", parameters: S({ expr: STR}, ["expr"]), run: (a) => diceTool(a.expr)},
{ name: "flip_coin", description: "抛硬币，times 是次数（1–20）。", parameters: S({ times: NUM}), run: (a) => coinTool(a.times)},
{ name: "draw_lot", description: "抽签（求签），返回签的等级和签诗。仅供娱乐。", parameters: S({}), run: () => drawLotTool()},
{ name: "tarot", description: "塔罗占卜抽牌，count 是张数（1–5，3 张最常用）。仅供娱乐。", parameters: S({ count: NUM}), run: (a) => tarotTool(a.count)},
{ name: "horoscope", description: "查今日星座运势。sign 给星座名，如 狮子座。仅供娱乐。", parameters: S({ sign: STR}, ["sign"]), run: (a, ctx) => horoscopeTool(a.sign, ctx && ctx.timezone)},
{ name: "almanac", description: "看今天的黄历信息：农历日期、干支年（生肖）、干支日。", parameters: S({}), run: (a, ctx) => almanacTool(ctx && ctx.timezone)},
];

/** OpenAI 工具表（function calling 格式）。 */
export const TOOL_SCHEMAS = TOOL_DEFS.map((d) => ({
type: "function",
function: { name: d.name, description: d.description, parameters: d.parameters},
}));

const TOOL_MAP = new Map(TOOL_DEFS.map((d) => [d.name, d]));

/**
* 执行一次工具调用。失败不抛：把错误如实写进结果给模型，让它向用户说明。
* @returns {Promise<string>} 给模型看的结果文本
*/
export async function executeTool(name, args, ctx) {
const def = TOOL_MAP.get(name);
if (!def) return `工具 ${name} 不存在。`;
try {
const out = await def.run(args || {}, ctx);
return cap(out);
} catch (err) {
if (ctx && ctx.logger) ctx.logger.error(`工具 ${name} 执行失败：${err.message}`);
return `工具 ${name} 这次没查到：${err.message}。请如实告诉用户这个功能暂时不可用，不要编造数据。`;
}
}

/* ---------------- 触发门 ---------------- */

const GATE_WORDS = [
"天气", "气温", "下雨", "下雪", "预报", "翻译", "译成", "翻成", "热搜", "热榜", "热门视频", "热度榜", "新闻", "热点", "头条",
"汇率", "换算", "币价", "比特币", "以太坊", "btc", "eth", "金价", "黄金", "白银价格", "油价", "票房",
"股价", "收盘", "股票", "股市", "大盘", "指数", "标普", "道琼斯", "纳斯达克", "纳指", "恒生", "日经", "上证",
"豆瓣", "维基", "百科", "wikidata", "duckduckgo", "归属", "ip地址", "一言", "古诗", "诗词", "图书",
"找书", "二维码", "短网址", "短链接", "还原", "base64", "摩斯", "哈希", "md5", "sha1", "sha256", "uuid",
"json", "进制", "单位", "多少天", "日期差", "随机数", "随机", "抽一个", "生成密码", "密码生成", "密码", "字数", "颜色",
"抽签", "求签", "骰子", "硬币", "塔罗", "星座", "运势", "黄历", "农历", "提醒我", "提醒一下", "提醒", "艾特", "分钟后", "小时后", "待办",
"github", "仓库", "时区", "几点", "现在时间", "电影", "上映", "汇率换算", "升国旗",
"照片", "图片", "壁纸", "长什么样", "发张", "来张", "看看图", "看图",
"生图", "生成", "生产", "实景照", "画一张", "画个", "画只", "做一张", "生成一张",
];

/** 问题是否可能需要工具（粗筛，宁宽勿漏；模型不用工具时这一轮就退化成普通非流式回答）。 */
export function toolGate(question) {
const q = String(question || "").toLowerCase();
if (!q) return false;
return GATE_WORDS.some((w) => q.includes(w.toLowerCase()));
}

/**
 * 从模型文本里提取被写成纯文本的工具调用：<tool_call>{"name": "...", "arguments": {...}}</tool_call>。
 * 有的提供方不走原生 function call、把调用写成这种标记文本（DeepSeek 系常见），管线要能识别并真执行，
 * 不能把标记原样发给用户。arguments 是对象或 JSON 字符串都认；解析不了的块跳过。
 */
export function extractTextToolCalls(text) {
  const calls = [];
  const s = String(text || "");
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (!obj || typeof obj.name !== "string") continue;
      let args = obj.arguments !== undefined ? obj.arguments : obj.args;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      calls.push({ name: obj.name, args: args && typeof args === "object" ? args : {} });
    } catch {
      // 不是合法 JSON 的块忽略。
    }
  }
  return calls;
}

/** 剥掉文本里的 <tool_call>...</tool_call> 块（抢救失败时的兜底，绝不能把标记发给用户）。 */
export function stripTextToolCalls(text) {
  return String(text || "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

/** 注入系统提示的工具说明（放在发言者断言之前，不抢占末尾断言的位置）。 */
export const TOOLS_PROMPT_NOTE =
"你有一组内置工具可以调用（查天气、翻译、热搜热榜、汇率、币价、金价、油价、票房、豆瓣电影、百科、IP 归属、一言、诗词、图书、二维码、短网址还原、编解码、哈希、进制/单位换算、日期计算、随机数、密码生成、字数统计、颜色换算、抽签、掷骰子、抛硬币、塔罗、星座运势、黄历、世界时间、设定时提醒、待办清单、GitHub 仓库搜索、搜图发图、生图）。用户想看某个人物/东西的照片或图片时，调用搜图发图工具把图发出去，不要只回文字描述。" +
"用户的问题需要实时数据、精确计算或这些功能时，先调用工具拿到结果再回答，不许凭记忆编造实时数据（天气、价格、热榜、票房尤其不许编）。工具返回失败或不可用时，如实告诉用户暂时查不到，不要用假数据糊弄。设提醒、记待办这类会落盘的功能，必须真的调用工具才算数：没调用工具、或工具没返回成功，绝不许声称已经设好、记好或存好。工具只能通过系统提供的调用机制使用，绝不要在回复正文里写 <tool_call> 标记或工具调用的 JSON。你可以 @ 当前说话人：他的用户名写在系统提示的发言者信息里，在回复正文里写 @用户名 就能 @ 到他；设定时提醒到点也会自动 @ 设定者。这些都是真能用的功能，不要声称 @ 不了、不知道对方用户名、或定时提醒没调通、用不了。你能生图：用户让你画/生成一张新图片时调用生图工具（generate_image），想看现成已有的照片才用搜图发图（find_photo），不要声称自己不会画图、发不了图。";
