// Outgoing mail servers of common mailboxes, so that setting up email takes an
// address and an app password. Each of these wants an app password (QQ and
// NetEase call it an authorization code) instead of the account password.

export interface MailProvider {
  name: string;
  host: string;
  port: number;
  /** TLS from the first byte (port 465); otherwise STARTTLS. */
  secure: boolean;
  /** Where the user gets the app password. */
  howToGetPassword: string;
}

const GMAIL: MailProvider = {
  name: "Gmail",
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  howToGetPassword: "turn on 2-Step Verification, then create an app password at https://myaccount.google.com/apppasswords",
};
const ICLOUD: MailProvider = {
  name: "iCloud Mail",
  host: "smtp.mail.me.com",
  port: 587,
  secure: false,
  howToGetPassword: "create an app-specific password at https://account.apple.com (Sign-In and Security > App-Specific Passwords)",
};
const YAHOO: MailProvider = {
  name: "Yahoo Mail",
  host: "smtp.mail.yahoo.com",
  port: 465,
  secure: true,
  howToGetPassword: "create an app password under Account Info > Account Security > Generate app password",
};
const FASTMAIL: MailProvider = {
  name: "Fastmail",
  host: "smtp.fastmail.com",
  port: 465,
  secure: true,
  howToGetPassword: "create an app password under Settings > Privacy & Security > Manage app passwords",
};
const QQ: MailProvider = {
  name: "QQ Mail",
  host: "smtp.qq.com",
  port: 465,
  secure: true,
  howToGetPassword: "in QQ Mail on the web: Settings > Account > turn on the POP3/SMTP service and generate an authorization code",
};
const netease = (domain: string): MailProvider => ({
  name: `NetEase ${domain}`,
  host: `smtp.${domain}`,
  port: 465,
  secure: true,
  howToGetPassword: `in ${domain} mail on the web: Settings > POP3/SMTP/IMAP > turn on SMTP and create an authorization code`,
});
const ALIYUN: MailProvider = {
  name: "Aliyun Mail",
  host: "smtp.aliyun.com",
  port: 465,
  secure: true,
  howToGetPassword: "turn on SMTP under Settings > POP3/SMTP/IMAP; use the password it gives you",
};

const PROVIDERS: Record<string, MailProvider> = {
  "gmail.com": GMAIL,
  "googlemail.com": GMAIL,
  "icloud.com": ICLOUD,
  "me.com": ICLOUD,
  "mac.com": ICLOUD,
  "yahoo.com": YAHOO,
  "ymail.com": YAHOO,
  "fastmail.com": FASTMAIL,
  "fastmail.fm": FASTMAIL,
  "qq.com": QQ,
  "foxmail.com": QQ,
  "163.com": netease("163.com"),
  "126.com": netease("126.com"),
  "yeah.net": netease("yeah.net"),
  "aliyun.com": ALIYUN,
};

/** Microsoft's consumer mailboxes only accept OAuth for sending mail now, which a plain SMTP login cannot do. */
const OAUTH_ONLY = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
}

/** The outgoing server for an address, when it is a mailbox we know. */
export function mailProviderFor(address: string): MailProvider | undefined {
  return PROVIDERS[domainOf(address)];
}

/** Why an address cannot send mail with an app password, or undefined when it can (or we do not know). */
export function unsupportedSender(address: string): string | undefined {
  const domain = domainOf(address);
  if (!OAUTH_ONLY.has(domain)) return undefined;
  return `Microsoft no longer lets ${domain} addresses send mail with a password (it requires OAuth). Send from another address, such as Gmail, iCloud or QQ Mail, or from your own SMTP server with --host`;
}
