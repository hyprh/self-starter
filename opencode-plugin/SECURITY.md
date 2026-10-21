# Security

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/hyprh/self-starter/security/advisories/new). If private reporting is unavailable, open an issue asking for a private contact without posting exploit details or credentials. This OpenCode integration has no supported published release yet.

Probe programs run as the current user by default. They can read files, run commands and use the network; write them to observe conditions only. An API-only probe can use `probe.access: sandbox` to restrict Deno to declared network hosts and environment variables. Treat probe results as untrusted data, never instructions.

Background actions use explicit OpenCode tool permissions. These do not provide operating-system isolation. Authorize the task and its side effects before activation. Notification-only actions do not invoke a model.

The native plugin takes session and working-directory identity from OpenCode's tool context, not model arguments. It resolves the user message that started the turn so that reporting a fire does not unlock trigger mutations later in that same turn. A daemon-started fire turn stays restricted throughout the headless process; it may only tune the firing trigger to be quieter.

Actions run in dedicated result sessions, with later events resuming the same session. The integration does not post events into the original conversation. Pause a trigger before manually continuing its result session, and install the native plugin only once.

Credentials belong in terminal configuration or Self-Starter's secret store, never in chat, probe source or trigger parameters. Local secrets are readable by the same operating-system user and are not encrypted at rest. Install only trusted code: plugins, probes and background actions run on the user's machine.
