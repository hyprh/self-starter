import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { OpenCodeCli } from "../../src/engine/opencode.js";

describe("OpenCode background configuration", () => {
  it("preserves JSONC and custom configuration while loading the managed plugin", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ss-opencode-config-"));
    const saved = { content: process.env.OPENCODE_CONFIG_CONTENT, dir: process.env.OPENCODE_CONFIG_DIR };
    const bin = join(scratch, "agent.mjs");
    writeFileSync(bin, `
      import { writeFileSync } from 'node:fs';
      for await (const chunk of process.stdin) {}
      writeFileSync('received.json', JSON.stringify({ dir: process.env.OPENCODE_CONFIG_DIR, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }));
      for (const [type, part] of [['text', {text:'Ready'}], ['step_finish', {reason:'stop'}]]) {
        console.log(JSON.stringify({type,sessionID:'ses_config',part}));
      }
    `);
    process.env.OPENCODE_CONFIG_DIR = join(scratch, "custom");
    process.env.OPENCODE_CONFIG_CONTENT = `{
      // OpenCode accepts comments and trailing commas here.
      "model": "local/configured",
      "plugin": [["existing-plugin", {"setting": true}]],
      "provider": {"local": {"options": {"baseURL": "http://127.0.0.1:1234"}}},
    }`;
    try {
      const globalDir = join(scratch, "global");
      const result = await new OpenCodeCli(bin, join(scratch, "sessions"), globalDir).run({
        cwd: scratch, message: "check", sandbox: "read-only", timeoutMs: 5000,
      });
      assert.equal(result.ok, true, result.error ?? "the configured runner failed");
      const received = JSON.parse(readFileSync(join(scratch, "received.json"), "utf8"));
      assert.equal(received.dir, join(scratch, "custom"));
      assert.equal(received.config.model, "local/configured");
      assert.equal(received.config.provider.local.options.baseURL, "http://127.0.0.1:1234");
      assert.deepEqual(received.config.plugin, [["existing-plugin", {setting:true}], pathToFileURL(join(globalDir, "plugins", "self-starter.js")).href]);
      rmSync(join(scratch, "received.json"));
      process.env.OPENCODE_CONFIG_CONTENT = '{"model": "partial", invalid}';
      const invalid = await new OpenCodeCli(bin, join(scratch, "sessions"), globalDir).run({
        cwd: scratch, message: "check", sandbox: "read-only", timeoutMs: 5000,
      });
      assert.equal(invalid.ok, false);
      assert.match(invalid.error!, /invalid OPENCODE_CONFIG_CONTENT/);
      assert.equal(existsSync(join(scratch, "received.json")), false, "invalid configuration cannot start a turn");
    } finally {
      for (const [key, value] of [["OPENCODE_CONFIG_CONTENT", saved.content], ["OPENCODE_CONFIG_DIR", saved.dir]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
