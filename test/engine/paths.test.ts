import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePaths } from "../../src/engine/paths.js";

describe("paths", () => {
  it("are the same however the home is written", () => {
    const home = join(process.cwd(), "a-folder-whose-path-is-long-enough-that-the-socket-moves-to-the-temp-folder", "self-starter");
    const plain = resolvePaths(home);
    for (const written of [`${home}/`, join(home, "..", "self-starter"), "a-folder-whose-path-is-long-enough-that-the-socket-moves-to-the-temp-folder/self-starter"]) {
      assert.deepEqual(resolvePaths(written), plain, written);
    }
    assert.equal(plain.home, home);
    assert.match(plain.socket, /self-starter-[0-9a-f]{16}\.sock$/);
  });
});
