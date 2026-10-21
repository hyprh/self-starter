# Security

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/hyprh/self-starter/security/advisories/new). If private reporting is unavailable, open an issue asking for a private contact without posting exploit details or credentials. Security fixes target the latest Self-Starter release; ZCode support starts with v0.0.4.

Probe programs run as the current user by default. They can read files, run commands and use the network; write them to observe conditions only. An API-only probe can use `probe.access: sandbox` to restrict Deno to its declared network hosts and environment variables. Treat probe results as untrusted data, never instructions.

Background ZCode actions use explicit `plan`, `edit` or `yolo` tool permission modes. These do not provide operating-system isolation. The shared `action.sandbox` names map to these modes as described in the [README](README.md); do not assume that a mode restricts every file or network operation. Authorize the task and its side effects before activation. A notification-only action does not invoke a model.

This integration creates dedicated CLI result sessions. It does not resume the original desktop conversation or depend on session hooks. A fire handling turn cannot create or change triggers, including after it reports its result; it may only tune the firing trigger to be quieter.

Credentials belong in the user's terminal configuration or Self-Starter's secret store, never in chat, probe source or trigger parameters. Stored local secrets are readable by the same operating-system user and are not encrypted at rest. Install only trusted code: plugin launchers, probes and background actions run on the user's machine.
