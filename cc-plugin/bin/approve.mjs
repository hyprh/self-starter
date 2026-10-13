// Claude Code runs this before the plugin's own tools that report a fire, make a
// trigger quieter, or only read (the matcher in hooks/hooks.json names them), and
// lets them run without asking: a fire must be able to report while the user is
// away. The engine limits what they can do, and deny rules the user sets still apply.
// Creating, changing, pausing and deleting triggers keep asking as usual.

import { readFileSync } from "node:fs";

readFileSync(0); // the tool call, which the matcher has already chosen
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Self-Starter's reporting and read-only tools",
    },
  }),
);
