import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../src/runtime.js";

for (const readOnly of [false, true]) {
  it(`finds usable bundled Deno after a blocked postinstall${readOnly ? " in a read-only package" : ""}`, (t) => {
    const require = createRequire(import.meta.url);
    const denoPackage = dirname(require.resolve("deno/package.json"));
    const scratch = mkdtempSync(join(tmpdir(), "ss-deno-no-postinstall-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    mkdirSync(join(scratch, "engine"));
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
    for (const file of ["config.js", "fs-util.js"]) {
      cpSync(join(PACKAGE_ROOT, "dist", "src", "engine", file), join(scratch, "engine", file));
    }
    const binaryName = process.platform === "win32" ? "deno.exe" : "deno";
    const copiedDeno = join(scratch, "node_modules", "deno");
    cpSync(denoPackage, copiedDeno, { recursive: true, filter: (source) => source !== join(denoPackage, binaryName) });
    const manifest = JSON.parse(readFileSync(join(denoPackage, "package.json"), "utf8")) as { optionalDependencies: Record<string, string> };
    // Link whichever optional platform package npm installed. Deno's own API
    // chooses the correct package on Linux/macOS, x64/arm64; tests share that logic.
    for (const name of Object.keys(manifest.optionalDependencies)) {
      let packageDir: string;
      try { packageDir = dirname(require.resolve(`${name}/package.json`)); }
      catch { continue; }
      const target = join(scratch, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(packageDir, target, "dir");
    }
    assert.equal(existsSync(join(copiedDeno, binaryName)), false);
    const script = `
import { bundledDeno } from ${JSON.stringify(pathToFileURL(join(scratch, "engine", "config.js")).href)};
import { spawnSync } from "node:child_process";
const binary = bundledDeno();
if (!binary) throw new Error("No bundled Deno without postinstall");
const result = spawnSync(binary, ["eval", "console.log(JSON.stringify({fire:true,summary:'probe works'}))"], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
console.log(JSON.stringify({ binary, probe: JSON.parse(result.stdout) }));
`;
    const nodeArgs = ["--input-type=module", "-e", script];
    const result = spawnSync(process.execPath, nodeArgs, {
      env: { ...process.env, DENO_SIMULATED_READONLY_FILE_SYSTEM: readOnly ? "1" : "0" }, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { binary: string; probe: object };
    assert.deepEqual(output.probe, { fire: true, summary: "probe works" });
    assert.equal(existsSync(join(copiedDeno, binaryName)), !readOnly);
    // require.resolve follows symlinks, including macOS's /var -> /private/var.
    const expectedBinary = join(realpathSync(copiedDeno), binaryName);
    if (!readOnly) assert.equal(output.binary, expectedBinary);
    else assert.notEqual(output.binary, expectedBinary, "read-only installs use the existing platform binary");
  });
}
