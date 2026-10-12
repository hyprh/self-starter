// Recipes: ready-made probes that ship with the plugin, such as the IBKR account
// watch. The agent picks a recipe and fills in its parameters instead of writing
// the probe; the recipe fixes the code, its access and permissions and the mode,
// so what runs is code we wrote and tested.
//
//   recipes/<id>/recipe.json   what it watches, its parameters, secrets and setup steps
//   recipes/<id>/<entry>       the probe

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RecipeParam {
  type: "string" | "number" | "boolean" | "string[]" | "number[]";
  description: string;
  required?: boolean;
  default?: unknown;
  /** Tuning knobs that rarely need changing; listed last. */
  advanced?: boolean;
}

export interface RecipeSecret {
  name: string;
  hosts: string[];
  howToGet: string;
}

export interface Recipe {
  id: string;
  version: number;
  title: string;
  summary: string;
  entry: string;
  mode: "state" | "event";
  /** "sandbox" for probes that only need the hosts in permissions.net; "full" (the default) otherwise. */
  access?: "full" | "sandbox";
  permissions: { net: string[]; env: string[] };
  interval?: { min: string; max: string; default: string };
  timeout?: string;
  params: Record<string, RecipeParam>;
  secrets: RecipeSecret[];
  setup: string[];
  /** A starting point for action.prompt when the user wants Codex to act on fires. */
  suggestedPrompt?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listRecipes(dir: string): Recipe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "recipe.json")))
    .map((entry) => loadRecipe(dir, entry.name).recipe)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadRecipe(dir: string, id: string): { recipe: Recipe; code: string } {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid recipe id: ${id}`);
  const file = join(dir, id, "recipe.json");
  if (!existsSync(file)) {
    const known = listRecipeIds(dir);
    throw new Error(`no recipe named ${id}${known.length ? ` (available: ${known.join(", ")})` : ""}`);
  }
  const recipe = { secrets: [], setup: [], ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Recipe>) } as Recipe;
  if (recipe.id !== id) throw new Error(`recipe ${id} declares the id ${recipe.id}`);
  return { recipe, code: readFileSync(join(dir, id, recipe.entry), "utf8") };
}

function listRecipeIds(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "recipe.json"))) : [];
}

function typeMatches(type: RecipeParam["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "number[]":
      return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
  }
}

/**
 * Fills a definition from a recipe: the recipe's entry, access, permissions and
 * mode replace whatever the caller sent, parameters get their defaults, and
 * unknown or mistyped parameters are rejected.
 */
export function applyRecipe(recipe: Recipe, raw: Record<string, unknown>): { definition: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const probe = isRecord(raw.probe) ? { ...raw.probe } : {};
  const access = recipe.access ?? "full";
  if (raw.mode !== undefined && raw.mode !== recipe.mode) errors.push(`the ${recipe.id} recipe runs in ${recipe.mode} mode`);
  if (probe.permissions !== undefined) {
    const same = JSON.stringify(probe.permissions) === JSON.stringify(recipe.permissions);
    if (!same) errors.push(`the ${recipe.id} recipe fixes the probe's permissions; leave probe.permissions out`);
  }
  if (probe.access !== undefined && probe.access !== access) errors.push(`the ${recipe.id} recipe runs with ${access} access; leave probe.access out`);

  const given = isRecord(probe.params) ? probe.params : {};
  const params: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(recipe.params)) {
    const value = given[name] ?? spec.default;
    if (value === undefined) {
      if (spec.required) errors.push(`probe.params.${name} is required: ${spec.description}`);
      continue;
    }
    if (!typeMatches(spec.type, value)) errors.push(`probe.params.${name} must be a ${spec.type}`);
    params[name] = value;
  }
  for (const name of Object.keys(given)) {
    if (!(name in recipe.params)) errors.push(`the ${recipe.id} recipe has no parameter ${name} (it has: ${Object.keys(recipe.params).join(", ")})`);
  }

  const definition: Record<string, unknown> = {
    ...raw,
    mode: recipe.mode,
    probe: {
      ...probe,
      entry: recipe.entry,
      access,
      params,
      permissions: recipe.permissions,
      ...(probe.interval === undefined && recipe.interval ? { interval: recipe.interval } : {}),
      ...(probe.timeout === undefined && recipe.timeout ? { timeout: recipe.timeout } : {}),
    },
  };
  return { definition, errors };
}
