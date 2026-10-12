---
name: run
description: Runs the codex-triggers feasibility checks. Use only when the user says "run the trigger spike".
---

# codex-triggers feasibility checks

This skill is only for validation and never creates a real trigger. Follow the steps in order. After each step, paste the raw result you got, without trimming or rewording it.

1. Run `echo "CODEX_THREAD_ID=$CODEX_THREAD_ID"` in the terminal and paste the output as is.
2. Call the MCP tool `spike_whoami` with `note` set to "desktop check", and paste the JSON it returns as is.
3. If step 1 printed a non-empty `CODEX_THREAD_ID`, call `spike_record_thread` with that value as `thread_id`. If it was empty, skip this step and say so.
4. Call `spike_path_check`. If the tool is missing or the call fails, say so.
5. Call `spike_confirm`. If a confirmation dialog appears, ask the user to click "Allow". Paste the tool's result as is.
6. Finish with a table that covers:
   - whether step 1 got a `CODEX_THREAD_ID`
   - the value of `threadId` in the `callMeta` from step 2, whether it matches step 1, and the `turn_trigger` inside `x-codex-turn-metadata`
   - whether `spike_path_check` from step 4 worked
   - whether a confirmation dialog appeared in step 5, and what the user chose

When you are done, remind the user to go back to the terminal and run `spike/scripts/02-queue.sh`.
