// v0.9.1 回归测试：「保存一直没用」根因是所有落盘路径按进程启动目录（cwd）解析。
// 本测试在子进程里故意从一个无关目录启动、把项目根指到另一目录，验证：
// 1) .env 从项目根读（换 cwd 不影响）；
// 2) saveConfigJson 写回项目根的 config.json，且启动目录里不产生同名文件。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const configUrl = new URL("../src/config.js", import.meta.url).href;

test("换启动目录：.env 与 config.json 仍按项目根读写", () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-root-"));
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "userbot-cwd-"));
  fs.writeFileSync(
    path.join(fakeRoot, ".env"),
    [
      "MY_USERNAME=rootbot",
      "OWNER_ID=42",
      "AI_API_KEY=<redacted>",
      "AI_API_BASE=https://root.example/v1",
      "AI_API_MODEL=root-model",
      "",
    ].join("\n"),
    "utf-8",
  );

  const script = `
    const { loadConfig, saveConfigJson } = await import(${JSON.stringify(configUrl)});
    const cfg = loadConfig();
    if (cfg.providers[0].model !== "root-model") {
      console.error("model mismatch: " + cfg.providers[0].model);
      process.exit(2);
    }
    saveConfigJson({ systemPrompt: "root-save-check" });
    console.log("child ok");
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: otherCwd,
    env: { ...process.env, KURUMI_ROOT_DIR: fakeRoot },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0, `子进程失败：${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /child ok/);

  const saved = JSON.parse(fs.readFileSync(path.join(fakeRoot, "config.json"), "utf-8"));
  assert.equal(saved.systemPrompt, "root-save-check");
  assert.equal(
    fs.existsSync(path.join(otherCwd, "config.json")),
    false,
    "启动目录里不该出现 config.json",
  );
});
