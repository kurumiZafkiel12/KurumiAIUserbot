// notebook.js 单元测试：事实清洗、去重、上限截断、机器人自述过滤、替换语义与持久化容错。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notebook, cleanFactLine, isSelfFact, sanitizeFacts } from "../src/notebook.js";

test("cleanFactLine：剥掉行首符号与空白，空行给空串", () => {
  assert.equal(cleanFactLine("- 小明：喜欢吃辣"), "小明：喜欢吃辣");
  assert.equal(cleanFactLine("  · 小明：喜欢吃辣 "), "小明：喜欢吃辣");
  assert.equal(cleanFactLine("- - 叠符号"), "叠符号");
  assert.equal(cleanFactLine(""), "");
  assert.equal(cleanFactLine("   "), "");
  assert.equal(cleanFactLine("- "), "");
  assert.equal(cleanFactLine("没有符号的一条"), "没有符号的一条");
});

test("isSelfFact：以机器人名字+冒号开头的算自述", () => {
  const names = ["大肥鱼", "机器人", "AI"];
  assert.equal(isSelfFact("大肥鱼：今天吃了两碗饭", names), true);
  assert.equal(isSelfFact("机器人:已上线", names), true);
  assert.equal(isSelfFact("小明：喜欢大肥鱼", names), false);
  assert.equal(isSelfFact("大家管机器人叫大肥鱼", names), false);
});

test("sanitizeFacts：去重、去空、过滤自述、保序", () => {
  const out = sanitizeFacts(
    ["- 小明：喜欢吃辣", "", "小明：喜欢吃辣", "机器人：我上线了", "· 阿紫：下周去东京"],
    { selfNames: ["机器人"] },
  );
  assert.deepEqual(out, ["小明：喜欢吃辣", "阿紫：下周去东京"]);
});

test("Notebook.addFacts：追加去重并返回新增数", () => {
  const nb = new Notebook(null);
  assert.equal(nb.addFacts("100", ["小明：喜欢吃辣", "阿紫：在东京上学"]), 2);
  assert.equal(nb.addFacts("100", ["小明：喜欢吃辣", "小明：养了只猫"]), 1);
  assert.deepEqual(nb.facts("100"), ["小明：喜欢吃辣", "阿紫：在东京上学", "小明：养了只猫"]);
  assert.deepEqual(nb.facts("999"), []);
});

test("Notebook.addFacts：超过上限丢最旧的", () => {
  const nb = new Notebook(null, { maxPerChat: 3 });
  nb.addFacts("1", ["事实一", "事实二", "事实三"]);
  nb.addFacts("1", ["事实四"]);
  assert.deepEqual(nb.facts("1"), ["事实二", "事实三", "事实四"]);
});

test("Notebook：按 botNames 过滤以机器人为主语的条目", () => {
  const nb = new Notebook(null, { botNames: ["大肥鱼"] });
  const added = nb.addFacts("1", ["大肥鱼：今天心情好", "小明：请大肥鱼吃过饭"]);
  assert.equal(added, 1);
  assert.deepEqual(nb.facts("1"), ["小明：请大肥鱼吃过饭"]);
});

test("Notebook.replace：全量替换；空结果不覆盖已有", () => {
  const nb = new Notebook(null);
  nb.addFacts("1", ["旧事实"]);
  assert.equal(nb.replace("1", ["新事实一", "新事实二"]), true);
  assert.deepEqual(nb.facts("1"), ["新事实一", "新事实二"]);
  assert.equal(nb.replace("1", []), false);
  assert.equal(nb.replace("1", ["", "  "]), false);
  assert.deepEqual(nb.facts("1"), ["新事实一", "新事实二"]);
});

test("Notebook.removeAt / clear：按 1 起序号删除，序号无效返回 null", () => {
  const nb = new Notebook(null);
  nb.addFacts("1", ["甲", "乙", "丙"]);
  assert.equal(nb.removeAt("1", 2), "乙");
  assert.deepEqual(nb.facts("1"), ["甲", "丙"]);
  assert.equal(nb.removeAt("1", 5), null);
  assert.equal(nb.removeAt("1", 0), null);
  assert.equal(nb.removeAt("2", 1), null);
  assert.equal(nb.clear("1"), 2);
  assert.deepEqual(nb.facts("1"), []);
  assert.equal(nb.clear("1"), 0);
});

test("Notebook.render：每条一行带「- 」前缀，空时返回空串", () => {
  const nb = new Notebook(null);
  assert.equal(nb.render("1"), "");
  nb.addFacts("1", ["小明：喜欢吃辣", "阿紫：在东京"]);
  assert.equal(nb.render("1"), "- 小明：喜欢吃辣\n- 阿紫：在东京");
});

test("Notebook：不同会话互不干扰，chatId 数字/字符串混用一致", () => {
  const nb = new Notebook(null);
  nb.addFacts(100, ["甲会话的事"]);
  nb.addFacts("200", ["乙会话的事"]);
  assert.deepEqual(nb.facts("100"), ["甲会话的事"]);
  assert.deepEqual(nb.facts(200), ["乙会话的事"]);
});

test("Notebook 持久化：写盘后新实例能读回；文件损坏不崩", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-test-"));
  const file = path.join(dir, "facts.json");
  const nb1 = new Notebook(file);
  nb1.addFacts("42", ["小明：喜欢吃辣"]);
  const nb2 = new Notebook(file);
  assert.deepEqual(nb2.facts("42"), ["小明：喜欢吃辣"]);

  fs.writeFileSync(file, "{这不是合法JSON", "utf-8");
  const nb3 = new Notebook(file);
  assert.deepEqual(nb3.facts("42"), []);
  nb3.addFacts("42", ["坏文件之后照样能记"]);
  assert.deepEqual(nb3.facts("42"), ["坏文件之后照样能记"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
