// Small pieces the command line shares: arguments, output, and reading a secret
// from the terminal without echoing it.

export interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Flags that take a value (`--to me@example.com`); all others are switches. */
const VALUE_FLAGS = new Set(["codex", "hosts", "to", "host", "port", "user", "from"]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-n") {
      flags.set("n", argv[++i] ?? "");
    } else if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      flags.set(name, inline ?? (VALUE_FLAGS.has(name) ? (argv[++i] ?? "") : true));
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** A flag's value, or undefined when it is missing or empty. */
export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

/** A mistake in how the command was called; it exits with status 2. */
export class UsageError extends Error {}

export function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}; see self-starter help`);
  return value;
}

/** A short local time for listings: "14:05" today, "Oct 5 14:05" otherwise. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Reads a secret: typed without echo in a terminal, or piped in on stdin. */
export function readSecret(prompt: string): Promise<string> {
  return process.stdin.isTTY ? readHidden(prompt) : readStdin();
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
