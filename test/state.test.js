// state.js 单元测试：全局暂停开关的落盘、重读与容错。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeState } from "../src/state.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-test-"));
  return path.join(dir, "state.json");
}

test("新状态默认未暂停", () => {
  const s = new RuntimeState(tmpFile());
  assert.equal(s.isPaused(), false);
});

test("setPaused 落盘后重新构造能读回关闭状态", () => {
  const file = tmpFile();
  const s = new RuntimeState(file);
  assert.equal(s.setPaused(true), true);
  assert.equal(s.isPaused(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { paused: true });

  const reopened = new RuntimeState(file);
  assert.equal(reopened.isPaused(), true);

  assert.equal(reopened.setPaused(false), true);
  assert.equal(new RuntimeState(file).isPaused(), false);
});

test("setPaused 值没变时返回 false 且不重复落盘", () => {
  const s = new RuntimeState(tmpFile());
  assert.equal(s.setPaused(false), false);
  s.setPaused(true);
  assert.equal(s.setPaused(true), false);
});

test("文件损坏或内容非法时按未暂停启动，不抛错", () => {
  const bad = tmpFile();
  fs.writeFileSync(bad, "{ 不是合法 json", "utf-8");
  assert.equal(new RuntimeState(bad).isPaused(), false);

  const weird = tmpFile();
  fs.writeFileSync(weird, JSON.stringify({ paused: "yes" }), "utf-8");
  assert.equal(new RuntimeState(weird).isPaused(), false);
});

test("null 路径是纯内存版：能开关，不落盘不报错", () => {
  const s = new RuntimeState(null);
  assert.equal(s.isPaused(), false);
  s.setPaused(true);
  assert.equal(s.isPaused(), true);
  s.setPaused(false);
  assert.equal(s.isPaused(), false);
});
