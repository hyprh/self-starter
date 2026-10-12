import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mailProviderFor, unsupportedSender } from "../../src/engine/mail-providers.js";

describe("mail providers", () => {
  it("knows the outgoing server of common mailboxes from the address alone", () => {
    assert.deepEqual(
      (({ host, port, secure }) => ({ host, port, secure }))(mailProviderFor("Someone@Gmail.com")!),
      { host: "smtp.gmail.com", port: 465, secure: true },
    );
    assert.equal(mailProviderFor("me@icloud.com")?.host, "smtp.mail.me.com");
    assert.equal(mailProviderFor("me@icloud.com")?.secure, false, "iCloud uses STARTTLS on 587");
    assert.equal(mailProviderFor("12345@qq.com")?.host, "smtp.qq.com");
    assert.equal(mailProviderFor("me@126.com")?.host, "smtp.126.com");
    assert.match(mailProviderFor("me@163.com")!.howToGetPassword, /authorization code/);
    assert.equal(mailProviderFor("me@example.org"), undefined);
  });

  it("explains why Microsoft's consumer mailboxes cannot send with a password", () => {
    assert.match(unsupportedSender("me@outlook.com") ?? "", /requires OAuth/);
    assert.equal(unsupportedSender("me@gmail.com"), undefined);
  });
});
