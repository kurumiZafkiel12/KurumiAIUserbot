// 帮助文本完整性：小节标题一个都不能少（防文本在编辑中被吞）。
import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_HELP_TEXT, PUBLIC_HELP_TEXT} from "../src/handlers.js";

const H = (s) => "";

test("号主帮助含全部小节", () => {
const sections = [
"基础", "用户名", "管理员", "拉黑/限速", "关键词", "API 管理", "识图",
"语音/人格", "群聊天记录", "搜索 Key", "破甲", "人设", "记事本", "机器人改名",
];
for (const s of sections) assert.ok(OWNER_HELP_TEXT.includes(H(s)), `缺小节 ${s}`);
});

test("号主帮助只列真实命令（关键命令齐全）", () => {
for (const cmd of [
"/ai 加识图", "/ai 加生图api", "/ai 加识图api", "/ai 换tts接口", "/ai 换ttskey", "/ai 加音色", "/ai 加人格",
"/ai 开启记录", "/ai 换搜索key", "/ai 破甲", "/ai 改名", "/ai 设人设",
// 0.2.1 新增/合并入口
"/ai 模型", "/ai 黑名单", "/ai 限速列表", "/ai 词列表", "/ai 删屏蔽", "/ai 屏蔽列表",
"/ai 切换api", "/ai 加api", "/ai 清空",
]) {
assert.ok(OWNER_HELP_TEXT.includes(cmd), `缺命令 ${cmd}`);
}
assert.ok(OWNER_HELP_TEXT.includes("改完立即生效"));
assert.ok(OWNER_HELP_TEXT.includes("确认"), "清空类应标注需再回确认");
});

test("公开帮助含公开命令四件", () => {
for (const cmd of ["/ai 帮助", "/ai 账单", "/ai 模型", "/ai 人设"]) {
assert.ok(PUBLIC_HELP_TEXT.includes(cmd), `公开帮助缺 ${cmd}`);
}
});
