// 语音（TTS）纯逻辑的单元测试：请求构造、音色选择优先级、朗读清洗、换音色句式。

import test from "node:test";
import assert from "node:assert/strict";
import { buildTtsRequest, pickVoiceName, cleanSpeechText, parseVoiceSwitch, voiceQueryKind } from "../src/tts.js";

test("buildTtsRequest：base 或 key 没配返回 null", () => {
  assert.equal(buildTtsRequest("", "k", "你好", ""), null);
  assert.equal(buildTtsRequest("https://tts.example/v1", "", "你好", ""), null);
});

test("buildTtsRequest：POST 到 base，Bearer key，body 带 text/format/reference_id", () => {
  const req = buildTtsRequest("https://tts.example/v1", "key-1", "你好世界", "voice-9");
  assert.equal(req.url, "https://tts.example/v1");
  assert.equal(req.options.method, "POST");
  assert.equal(req.options.headers.Authorization, "Bearer key-1");
  const body = JSON.parse(req.options.body);
  assert.equal(body.text, "你好世界");
  assert.equal(body.format, "mp3");
  assert.equal(body.reference_id, "voice-9");
  const noVoice = buildTtsRequest("https://tts.example/v1", "key-1", "你好", "");
  assert.equal(JSON.parse(noVoice.options.body).reference_id, undefined);
});

test("pickVoiceName：个人 > 群 > 音色库第一个 > 空", () => {
  const cfg = {
    voiceBook: { 甲: "id-a", 乙: "id-b" },
    voiceByChat: { g1: "乙" },
    voiceByChatUser: { g1_u1: "甲" },
  };
  assert.deepEqual(pickVoiceName(cfg, "g1", "u1"), { name: "甲", id: "id-a" });
  assert.deepEqual(pickVoiceName(cfg, "g1", "u2"), { name: "乙", id: "id-b" });
  assert.deepEqual(pickVoiceName(cfg, "g2", "u2"), { name: "甲", id: "id-a" });
  assert.deepEqual(pickVoiceName({ voiceBook: {} }, "g", "u"), { name: "", id: "" });
});

test("cleanSpeechText 去掉 Markdown 标记并压空白", () => {
  assert.equal(cleanSpeechText("**重点** 是 `代码`\n## 标题"), "重点 是 代码 标题");
});

test("parseVoiceSwitch 认换音色句式，不认普通问题", () => {
  assert.equal(parseVoiceSwitch("换音色 塔菲"), "塔菲");
  assert.equal(parseVoiceSwitch("音色换成 塔菲"), "塔菲");
  assert.equal(parseVoiceSwitch("把我的音色换成 塔菲"), "塔菲");
  assert.equal(parseVoiceSwitch("切换音色为 塔菲"), "塔菲");
  assert.equal(parseVoiceSwitch("今天天气怎么样"), null);
  assert.equal(parseVoiceSwitch("换音色"), null);
});

test("voiceQueryKind 认列表/当前音色问法", () => {
  assert.equal(voiceQueryKind("音色列表"), "list");
  assert.equal(voiceQueryKind("当前音色"), "current");
  assert.equal(voiceQueryKind("音色"), null);
});
