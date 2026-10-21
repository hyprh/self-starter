import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type Hooks, type PluginInput, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { opencodeRef } from "../core/conversations.js";
import { resolvePaths, type Paths } from "../engine/paths.js";
import type { Caller } from "../engine/service.js";
import { createToolCaller, TOOLS } from "../mcp/server.js";
import { PACKAGE_ROOT } from "../runtime.js";

interface Property {
  type: string;
  description: string;
  minimum?: number;
}

function propertyOf(property: Property) {
  switch (property.type) {
    case "string": return tool.schema.string();
    case "boolean": return tool.schema.boolean();
    case "number": return tool.schema.number();
    case "integer": {
      const value = tool.schema.number().int();
      return property.minimum === undefined ? value : value.min(property.minimum);
    }
    case "object": return tool.schema.record(tool.schema.string(), tool.schema.unknown());
    default: throw new Error(`unsupported Self-Starter tool property: ${property.type}`);
  }
}

/** These tools use the same simple property types as the MCP definitions. */
function argumentsOf(schema: { properties: object; required?: string[] }): ToolDefinition["args"] {
  return Object.fromEntries(Object.entries(schema.properties).map(([name, property]: [string, Property]) => {
    const value = propertyOf(property).describe(property.description);
    return [name, schema.required?.includes(name) ? value : value.optional()];
  }));
}

export interface OpenCodePluginOptions {
  home?: string;
  /** Tests run a control server without starting a background service. */
  ensureDaemon?: (paths: Paths) => Promise<unknown>;
}

/** Native tools receive session identity from OpenCode, never from model arguments. */
export async function createSelfStarterPlugin(input: PluginInput, options: OpenCodePluginOptions = {}): Promise<Hooks> {
  const paths = resolvePaths(options.home);
  const call = createToolCaller({ paths, ensureDaemon: options.ensureDaemon });
  const skill = readFileSync(join(PACKAGE_ROOT, "opencode-plugin", "skills", "triggers", "SKILL.md"), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // A daemon-started process owns this whole turn, including tool calls after its receipt.
  const triggerTurn = process.env.SELF_STARTER_TRIGGER_TURN === "1";

  const callerOf = async (context: ToolContext): Promise<Caller> => {
    const { data } = await input.client.session.message({
      path: { id: context.sessionID, messageID: context.messageID },
      query: { directory: context.directory },
      throwOnError: true,
    });
    const message = data?.info;
    const turnId = message?.role === "assistant" ? message.parentID : message?.id;
    if (!turnId) throw new Error("OpenCode did not supply the user message that started this turn.");
    return {
      via: "mcp",
      threadId: opencodeRef(context.sessionID),
      turnId,
      cwd: context.directory,
      ...(triggerTurn ? { turnTrigger: "self-starter" } : {}),
    };
  };

  return {
    tool: Object.fromEntries(TOOLS.map((definition) => [definition.name, tool({
      description: definition.description,
      args: argumentsOf(definition.inputSchema),
      async execute(args, context) {
        await context.ask({ permission: definition.name, patterns: ["*"], always: ["*"], metadata: {} });
        const result = await call(definition.name, args, await callerOf(context));
        const output = result.content.map((part) => part.text).join("\n");
        if (result.isError) throw new Error(output);
        return output;
      },
    })])),
    "experimental.chat.system.transform": async (_context, output) => {
      output.system.push(skill);
    },
  };
}
