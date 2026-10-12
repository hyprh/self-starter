// Secrets for probes (API keys), kept in a file only the current user can read.
//
// Each secret names the hosts it may be sent to. A probe only receives a secret
// when it declares the secret in permissions.env and every host it can reach is
// one of the secret's hosts, so a probe cannot send a key anywhere the user did
// not intend, even during the trial run before approval.

import { chmodSync, existsSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./fs-util.js";
import type { Paths } from "./paths.js";

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export interface SecretEntry {
  value: string;
  /** Hosts the secret may be sent to, or "*" for any host. */
  hosts: string[] | "*";
}

export interface PickResult {
  values: Record<string, string>;
  /** Human-readable reasons why secrets were withheld, empty when all were released. */
  problems: string[];
}

/** Lower-case host name without a port or IPv6 brackets. */
export function hostName(entry: string): string {
  const lower = entry.trim().toLowerCase();
  if (lower.startsWith("[")) return lower.slice(1, lower.indexOf("]"));
  return lower.replace(/:\d+$/, "");
}

export class Secrets {
  constructor(private readonly paths: Paths) {}

  private load(): Record<string, SecretEntry> {
    return readJson<Record<string, SecretEntry>>(this.paths.secrets) ?? {};
  }

  private save(all: Record<string, SecretEntry>): void {
    writeJsonAtomic(this.paths.secrets, all);
    if (existsSync(this.paths.secrets)) chmodSync(this.paths.secrets, 0o600);
  }

  list(): Array<{ name: string; hosts: string[] | "*" }> {
    return Object.entries(this.load())
      .map(([name, entry]) => ({ name, hosts: entry.hosts }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  set(name: string, value: string, hosts: string[] | "*"): void {
    if (!NAME_PATTERN.test(name)) throw new Error(`invalid secret name: ${name} (use upper-case letters, digits and _)`);
    if (value === "") throw new Error("the secret value is empty");
    if (hosts !== "*" && hosts.length === 0) throw new Error("name at least one host the secret may be sent to");
    const all = this.load();
    all[name] = { value, hosts: hosts === "*" ? "*" : [...new Set(hosts.map(hostName))] };
    this.save(all);
  }

  remove(name: string): boolean {
    const all = this.load();
    if (!(name in all)) return false;
    delete all[name];
    this.save(all);
    return true;
  }

  /** Releases the declared secrets whose hosts cover every host the probe can reach. */
  pick(names: string[], probeHosts: string[]): PickResult {
    const all = this.load();
    const values: Record<string, string> = {};
    const problems: string[] = [];
    const reachable = [...new Set(probeHosts.map(hostName))];
    for (const name of names) {
      const entry = all[name];
      if (!entry) {
        problems.push(`secret ${name} is not set (ask the user to run: ctrig secret set ${name} --hosts ${reachable.join(",") || "<host>"})`);
        continue;
      }
      const outside = entry.hosts === "*" ? [] : reachable.filter((host) => !(entry.hosts as string[]).includes(host));
      if (outside.length > 0) {
        problems.push(`secret ${name} may only be sent to ${(entry.hosts as string[]).join(", ")}, but the probe can also reach ${outside.join(", ")}`);
        continue;
      }
      values[name] = entry.value;
    }
    return { values, problems };
  }
}
