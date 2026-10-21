import { createSelfStarterPlugin } from "../dist/src/opencode/plugin.js";

// One export: OpenCode loads each exported function as a separate plugin.
export default createSelfStarterPlugin;
