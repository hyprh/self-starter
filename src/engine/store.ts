// Trigger definitions, probe code, runtime state and drafts on disk.
//
//   triggers/<id>/trigger.yaml   definition (what should be)
//   triggers/<id>/<entry>        probe code
//   triggers/<id>/state.json     runtime state (what is), written only by the daemon
//   drafts/<draft-id>/...        tried once, not active yet

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { definitionToYaml, parseDefinitionYaml, type TriggerDefinition } from "../core/definition.js";
import type { RuntimeState } from "../core/state-machine.js";
import { ensurePrivateDir, readJson, writeFileAtomic, writeJsonAtomic } from "./fs-util.js";
import type { Paths } from "./paths.js";

export interface LoadedTrigger {
  definition: TriggerDefinition;
  probeCode: string;
  dir: string;
}

export interface DryRun {
  ok: boolean;
  durationMs: number;
  summary?: string;
  fire?: boolean;
  events?: number;
  nextCheckIn?: string;
  error?: string;
  stderr?: string;
}

export interface DraftMeta {
  draftId: string;
  createdAt: string;
  originThreadId: string | null;
  /** Set when the draft replaces an existing trigger's code or permissions. */
  replaces?: string;
  dryRun?: DryRun;
}

export interface LoadedDraft extends LoadedTrigger {
  meta: DraftMeta;
}

export class Store {
  constructor(readonly paths: Paths) {}

  ensureLayout(): void {
    ensurePrivateDir(this.paths.home);
    ensurePrivateDir(this.paths.triggers);
    ensurePrivateDir(this.paths.drafts);
    ensurePrivateDir(this.paths.logs);
  }

  triggerDir(id: string): string {
    return join(this.paths.triggers, id);
  }

  draftDir(draftId: string): string {
    return join(this.paths.drafts, draftId);
  }

  listTriggerIds(): string[] {
    if (!existsSync(this.paths.triggers)) return [];
    return readdirSync(this.paths.triggers, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.paths.triggers, entry.name, "trigger.yaml")))
      .map((entry) => entry.name)
      .sort();
  }

  private loadFrom(dir: string): LoadedTrigger {
    const parsed = parseDefinitionYaml(readFileSync(join(dir, "trigger.yaml"), "utf8"));
    if (!parsed.ok) throw new Error(`invalid trigger.yaml: ${parsed.errors.join("; ")}`);
    const probePath = join(dir, parsed.definition.probe.entry);
    if (!existsSync(probePath)) throw new Error(`probe file is missing: ${parsed.definition.probe.entry}`);
    return { definition: parsed.definition, probeCode: readFileSync(probePath, "utf8"), dir };
  }

  loadTrigger(id: string): LoadedTrigger {
    return this.loadFrom(this.triggerDir(id));
  }

  hasTrigger(id: string): boolean {
    return existsSync(join(this.triggerDir(id), "trigger.yaml"));
  }

  saveDefinition(definition: TriggerDefinition): void {
    writeFileAtomic(join(this.triggerDir(definition.id), "trigger.yaml"), definitionToYaml(definition));
  }

  deleteTrigger(id: string): void {
    rmSync(this.triggerDir(id), { recursive: true, force: true });
  }

  loadRuntime(id: string): RuntimeState | undefined {
    return readJson<RuntimeState>(join(this.triggerDir(id), "state.json"));
  }

  saveRuntime(id: string, runtime: RuntimeState): void {
    if (!this.hasTrigger(id)) return; // deleted while a probe was running
    writeJsonAtomic(join(this.triggerDir(id), "state.json"), runtime);
  }

  createDraft(definition: TriggerDefinition, probeCode: string, meta: Omit<DraftMeta, "draftId" | "createdAt">): LoadedDraft {
    const draftId = `draft-${definition.id}-${randomBytes(3).toString("hex")}`;
    const dir = this.draftDir(draftId);
    ensurePrivateDir(dir);
    writeFileAtomic(join(dir, "trigger.yaml"), definitionToYaml(definition));
    writeFileAtomic(join(dir, definition.probe.entry), probeCode);
    const fullMeta: DraftMeta = { draftId, createdAt: new Date().toISOString(), ...meta };
    writeJsonAtomic(join(dir, "draft.json"), fullMeta);
    return { definition, probeCode, dir, meta: fullMeta };
  }

  loadDraft(draftId: string): LoadedDraft {
    if (!/^draft-[a-z0-9-]+$/.test(draftId)) throw new Error(`invalid draft id: ${draftId}`);
    const dir = this.draftDir(draftId);
    if (!existsSync(join(dir, "draft.json"))) throw new Error(`no such draft: ${draftId}`);
    const loaded = this.loadFrom(dir);
    return { ...loaded, meta: readJson<DraftMeta>(join(dir, "draft.json"))! };
  }

  saveDraftMeta(meta: DraftMeta): void {
    writeJsonAtomic(join(this.draftDir(meta.draftId), "draft.json"), meta);
  }

  listDrafts(): DraftMeta[] {
    if (!existsSync(this.paths.drafts)) return [];
    return readdirSync(this.paths.drafts)
      .map((name) => readJson<DraftMeta>(join(this.paths.drafts, name, "draft.json")))
      .filter((meta): meta is DraftMeta => meta !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deleteDraft(draftId: string): void {
    rmSync(this.draftDir(draftId), { recursive: true, force: true });
  }

  /**
   * Turns a draft into a trigger: writes the final definition into the draft
   * folder, then moves the folder into place, replacing an older version.
   */
  promoteDraft(draftId: string, definition: TriggerDefinition): void {
    const dir = this.draftDir(draftId);
    writeFileAtomic(join(dir, "trigger.yaml"), definitionToYaml(definition));
    rmSync(join(dir, "draft.json"), { force: true });
    const target = this.triggerDir(definition.id);
    const previousState = readJson<RuntimeState>(join(target, "state.json"));
    rmSync(target, { recursive: true, force: true });
    renameSync(dir, target);
    if (previousState) writeJsonAtomic(join(target, "state.json"), previousState);
  }
}
