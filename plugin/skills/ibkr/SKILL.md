---
name: ibkr
description: Keep an eye on an Interactive Brokers (IBKR) account and speak up when something changes - new executions, option assignments and exercises, deposits and withdrawals, positions that changed without a trade, big moves in net asset value. Use when the user wants Codex to watch their IBKR account, and when handling a fire of an IBKR trigger.
---

# Watch an IBKR account

This sets up a trigger from the ready-made recipe `ibkr-account`. Read the skill `codex-triggers:triggers` first for how triggers, approval and fire messages work.

The recipe reads Interactive Brokers' Flex Web Service with a read-only token: it can read reports, it cannot trade or move money.

## What the user sets up once (about 5 minutes, in IBKR)

Walk the user through these steps; they happen in the IBKR Client Portal and a terminal, not in the chat.

1. Client Portal > Performance & Reports > Flex Queries.
2. Create a **Trade Confirmation Flex Query**: section Trade Confirmations, format XML, period Today. Note its Query ID. This reports new executions 5 to 10 minutes after they happen.
3. Optional, recommended: create an **Activity Flex Query** with Open Positions, Cash Transactions, Net Asset Value (NAV) in Base, Change in NAV and Trades; format XML; period Last Business Day. Note its Query ID. This adds deposits and withdrawals, position changes and NAV moves, once a day after the close.
4. On the Flex Queries page, open Flex Web Service Configuration, enable it and generate a token.
5. In a terminal: `ctrig secret set IBKR_FLEX_TOKEN --hosts ndcdyn.interactivebrokers.com,gdcdyn.interactivebrokers.com` and paste the token when asked. The token must never be pasted into the chat; if the user offers it, tell them to use the command instead.
6. Optional: `ctrig channel email ...` to also get the results by email (see `ctrig help`).

Query IDs are not secret; the user can tell you them in the chat.

## Create the trigger

Call `trigger_recipes` to see the recipe's parameters, then `trigger_draft` with `recipe: "ibkr-account"` and a definition like this (no code, no permissions: the recipe supplies them):

```json
{
  "id": "ibkr-watch",
  "name": "IBKR account watch",
  "intent": "<the user's words>",
  "probe": { "params": { "trade_query_id": "123456", "activity_query_id": "123457", "nav_move_pct": 3 } },
  "action": { "type": "agent", "prompt": "<see below>", "sandbox": "read-only" },
  "target": { "kind": "dedicated", "cwd": "<a notes folder, or leave out>" },
  "notify": { "when": "receipt", "channels": ["desktop", "email"] }
}
```

- Parameters: `trade_query_id` and/or `activity_query_id` (at least one), `nav_move_pct` (default 3), `large_trade_value` (only report executions worth at least this much; default 0 = all), `cash_types` (default `["Deposits/Withdrawals"]`; add `"Dividends"` if the user wants those), `watch` (default all of `trades`, `cash`, `positions`, `nav`).
- Leave `channels` out unless the user asked for email; `"email"` only works after `ctrig channel email` (`service_status` shows which channels are set up).
- If the user only wants to be told, use `"action": {"type": "notify"}`: every change becomes a notification, without Codex.
- A good `action.prompt` (adapt it to what the user asked): "Something changed in my IBKR account. For each change, say what it is (my own order filling, an option assignment or exercise, a dividend, a transfer), whether it looks expected or unusual, and what I should check. Put anything that could be unauthorized, such as a trade or withdrawal I did not make, first. Do not place orders or change anything. Keep it short."
- Checks run every 15 minutes around US market hours and every 2 hours otherwise; IBKR asks clients not to poll more often. The first check only records what is there; changes after that fire.

Tell the user, before `trigger_activate`: what is watched, how quickly they hear about each kind of change (executions 5 to 10 minutes; cash, positions and NAV the morning after), where results go, and that the token is read-only.

## Handling a fire

The `<trigger-data>` block lists events with keys such as `trade:U1234567:...`, `cash:...`, `position:...`, `nav:...`.

- Group by account. Lead with anything that could be unauthorized or risky: a trade or withdrawal the user may not have made, an option assignment, a large NAV drop.
- For each event, say in plain words what happened and whether it looks expected. If the action prompt mentions the user's notes or plans, compare with them.
- Never place orders, move money, or log in anywhere; IBKR data here is read-only. Suggest what the user should check in IBKR instead.
- Set `notify` to true when something needs the user's attention, false for routine fills they clearly expect.

## Limits to mention when relevant

- Not real time: executions arrive 5 to 10 minutes late, and positions, cash and NAV once a day. Intraday margin or price alerts need another source (a price trigger, or IBKR's own alerts).
- Accounts with more than 100 changes in one check report the latest 100.
