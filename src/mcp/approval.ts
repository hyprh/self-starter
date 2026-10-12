// Asking the user to approve a trigger. The agent cannot answer these dialogs:
// first an MCP elicitation, which Codex shows in the thread; when Codex declines
// it on its own (threads whose approval policy is "never"), a native dialog.

import { spawn } from "node:child_process";
import { which } from "../engine/config.js";

export type Decision = "approved" | "declined" | "unavailable";

export interface ElicitResult {
  action: string;
  content?: Record<string, unknown>;
}

export type Elicit = (params: { message: string; requestedSchema: Record<string, unknown> }) => Promise<ElicitResult | undefined>;

/** Codex answers an elicitation it may not show at once; a person takes longer than this. */
const AUTOMATIC_DECLINE_MS = 1500;
const DIALOG_TIMEOUT_S = 600;

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A native yes/no dialog: osascript on macOS, zenity or kdialog on Linux desktops. */
export async function nativeDialog(message: string): Promise<Decision> {
  if (process.platform === "darwin") {
    const script =
      `display dialog ${appleScriptString(message)} with title "codex-triggers" ` +
      `buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after ${DIALOG_TIMEOUT_S}`;
    const out = await run("osascript", ["-e", script]);
    if (out.code === null) return "unavailable";
    return out.stdout.includes("button returned:Approve") && !out.stdout.includes("gave up:true") ? "approved" : "declined";
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "unavailable";
  const zenity = which("zenity");
  if (zenity) {
    const out = await run(zenity, [
      "--question",
      "--title=codex-triggers",
      "--no-markup",
      "--width=640",
      "--ok-label=Approve",
      "--cancel-label=Deny",
      `--timeout=${DIALOG_TIMEOUT_S}`,
      `--text=${message}`,
    ]);
    if (out.code === null) return "unavailable";
    return out.code === 0 ? "approved" : "declined";
  }
  const kdialog = which("kdialog");
  if (kdialog) {
    const out = await run(kdialog, ["--title", "codex-triggers", "--yes-label", "Approve", "--no-label", "Deny", "--yesno", message]);
    if (out.code === null) return "unavailable";
    return out.code === 0 ? "approved" : "declined";
  }
  return "unavailable";
}

export interface ApprovalOutcome {
  decision: Decision;
  via: "elicitation" | "dialog" | "none";
}

export async function askApproval(message: string, elicit: Elicit | undefined, dialog = nativeDialog): Promise<ApprovalOutcome> {
  if (elicit) {
    const started = Date.now();
    const response = await elicit({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve", description: "Approve this trigger" },
        },
        required: ["approve"],
      },
    });
    if (response?.action === "accept") {
      return { decision: response.content?.approve === true ? "approved" : "declined", via: "elicitation" };
    }
    if (response && Date.now() - started >= AUTOMATIC_DECLINE_MS) return { decision: "declined", via: "elicitation" };
    // No answer, or declined at once by Codex itself: fall back to a native dialog.
  }
  const decision = await dialog(message);
  return { decision, via: decision === "unavailable" ? "none" : "dialog" };
}
