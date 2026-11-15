// 识图池纯逻辑的单元测试：规范化、展开、加权挑选、列表文本。

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVisionPool, flattenVisionPool, pickVisionEntry, visionListText } from "../src/vision.js";

test("normalizeVisionPool 容忍对象/字符串/数组混写，丢掉没模型名的条目", () => {
  const pool = normalizeVisionPool({
    a: [{ model: "m1", weight: 3 }, { model: "m2" }],
    b: { model: "m3", weight: 0 },
    c: "m4",
    d: [{ weight: 5 }],
    e: [],
  });
  assert.deepEqual(pool.a, [
    { model: "m1", weight: 3 },
    { model: "m2", weight: 7 },
  ]);
  assert.deepEqual(pool.b, [{ model: "m3", weight: 7 }]);
  assert.deepEqual(pool.c, [{ model: "m4", weight: 7 }]);
  assert.equal(pool.d, undefined);
  assert.equal(pool.e, undefined);
});

test("normalizeVisionPool 非法输入返回空对象", () => {
  assert.deepEqual(normalizeVisionPool(null), {});
  assert.deepEqual(normalizeVisionPool("x"), {});
  assert.deepEqual(normalizeVisionPool(undefined), {});
});

test("flattenVisionPool 按 API 名与数组序稳定展开", () => {
  const items = flattenVisionPool({ a: [{ model: "m1", weight: 1 }], b: [{ model: "m2", weight: 2 }, { model: "m3", weight: 3 }] });
  assert.deepEqual(
    items.map((i) => `${i.apiName}::${i.model}`),
    ["a::m1", "b::m2", "b::m3"],
  );
});

test("pickVisionEntry 按权重挑选（rng 注入可复现）", () => {
  const items = [
    { apiName: "a", model: "m1", weight: 1 },
    { apiName: "b", model: "m2", weight: 9 },
  ];
  assert.equal(pickVisionEntry(items, () => 0).model, "m1");
  assert.equal(pickVisionEntry(items, () => 0.5).model, "m2");
  assert.equal(pickVisionEntry([], () => 0), null);
});

test("visionListText 编号列出条目与权重，空池返回空串", () => {
  assert.equal(visionListText({}), "");
  const t = visionListText({ a: [{ model: "m1", weight: 5 }] });
  assert.equal(t, "1. a → m1（权重 5）");
});
