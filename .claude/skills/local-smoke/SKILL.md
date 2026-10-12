---
name: local-smoke
description: Fast pre-deploy sanity check against a throwaway SQLite DB and a non-default port. Exercises the CLI (add/list/toggle/remove + validation errors) and boots the MCP HTTP server long enough to confirm it listens and `tools/list` returns the full tool surface. Use before `/deploy-local` to catch boot-time regressions that `npm test` doesn't. Never touches real lake data.
---

# /local-smoke — waldo.WTF pre-deploy smoke test

You are about to deploy or ship a change. `npm test` covers unit + contract +
HTTP tests, but it does **not** boot the real bootstrap path in
[src/index.ts](../../../src/index.ts) — which is where env wiring, real
SQLite open, steering-store construction, and OAuth conditional mounting
actually run. This skill closes that gap in ~30 seconds, using throwaway
state so it cannot corrupt the real lake.

## When to run

- **Always** before `/deploy-local`, after tests are green.
- On demand when the user asks to "smoke test" or "dry-run" locally.
- After editing [src/index.ts](../../../src/index.ts), [src/cli.ts](../../../src/cli.ts),
  [src/config.ts](../../../src/config.ts), or any `src/mcp/http-server*` file.

Not a substitute for `npm test`. Run the suite first; only run smoke when
it's green.

## Invariants

- Throwaway DB at `$WALDO_SMOKE_DB_PATH` (default `/tmp/waldo-smoke.db`).
  `rm -f` it before and after. Never touch `WALDO_DB_PATH`.
- Non-default port `$WALDO_SMOKE_PORT` (default `18765`) so nothing
  collides with a running dev server on 8765.
- `BEARER_TOKEN` + `MS_CLIENT_ID` come from [.env](../../../.env) — the
  skill does not create, rotate, or echo them.
- No Graph traffic. The sync scheduler will start and fail auth silently
  against the empty throwaway DB; that's expected and harmless.

## Step 0 — Preflight

Run tests first. Do not continue on failure.

```sh
npm test
```

Then pull the smoke config. Use the env vars if set, else the defaults.

```sh
SMOKE_DB="${WALDO_SMOKE_DB_PATH:-/tmp/waldo-smoke.db}"
SMOKE_PORT="${WALDO_SMOKE_PORT:-18765}"
```

## Step 1 — Clean slate

Wipe the throwaway DB (and its WAL/SHM siblings) so each run starts from
migration 0.

```sh
rm -f "$SMOKE_DB" "$SMOKE_DB-wal" "$SMOKE_DB-shm"
```

## Step 2 — CLI steering round-trip

Each command is one `npx tsx src/cli.ts ...` invocation with
`WALDO_DB_PATH="$SMOKE_DB"` prefixed. Assert the printed output — a
silent success is NOT proof of success.

1. **Add two rules:**
   ```sh
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts \
     --steer-add-domain marketing.example.com --reason "smoke"
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts \
     --steer-add-sender Bob@Example.COM --source outlook
   ```
   Expect: `added steering rule #1: sender_domain=marketing.example.com`
   and `added steering rule #2: sender_email=bob@example.com source=outlook`
   (note the lowercased pattern — normalization is load-bearing).

2. **List:**
   ```sh
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-list
   ```
   Expect a tab-separated table with the header `id	type	pattern	scope	enabled`
   and both rules.

3. **Disable + remove:**
   ```sh
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-disable 1
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-remove 2
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-list
   ```
   Expect `rule #1 disabled`, `removed 1 rule`, then a list showing only
   rule #1 with `enabled=no`.

4. **Validation errors** (these MUST throw `CliUsageError` and exit
   non-zero):
   ```sh
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-add-domain foo@x.com
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-remove 0
   ```
   Expect `--steer-add-domain pattern must not contain '@'` and
   `--steer-remove expects a positive integer, got "0"`. If either
   command exits zero, that's a regression — stop and investigate.

5. **No-op remove:**
   ```sh
   WALDO_DB_PATH="$SMOKE_DB" npx tsx src/cli.ts --steer-remove 999
   ```
   Expect `no rule removed`, exit 0.

## Step 3 — Boot the MCP server and probe `tools/list`

This is the piece `npm test` cannot cover — the real Node process coming
up with a real SQLite file under `src/index.ts`.

Boot in **production shape**: OAuth on the public port (so it is
OAuth-only) plus the loopback internal listener for the static bearer.

```sh
SMOKE_INTERNAL_PORT=$((SMOKE_PORT + 1))
WALDO_DB_PATH="$SMOKE_DB" WALDO_PORT="$SMOKE_PORT" \
  WALDO_PUBLIC_URL="http://localhost:$SMOKE_PORT" \
  WALDO_INTERNAL_PORT="$SMOKE_INTERNAL_PORT" \
  npx tsx src/index.ts > /tmp/waldo-smoke-boot.log 2>&1 &
sleep 3

BEARER="$(grep BEARER_TOKEN .env | cut -d= -f2)"
list_tools() {
  curl -sS -o /tmp/waldo-smoke-body.txt -w "%{http_code}" \
    -H "Authorization: Bearer $BEARER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -X POST "http://127.0.0.1:$1/mcp" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
}
echo "public:   $(list_tools "$SMOKE_PORT")"            # expect 401 (OAuth-only)
echo "internal: $(list_tools "$SMOKE_INTERNAL_PORT")"   # expect 200
cat /tmp/waldo-smoke-body.txt
grep -c "internal MCP listener (static bearer only)" /tmp/waldo-smoke-boot.log   # expect 1
kill %1 2>/dev/null; wait %1 2>/dev/null
```

The **public** probe must be `401` — a `200` there means the static
bearer leaked back onto the Funnel-exposed port (security regression,
see [docs/oauth.md](../../../docs/oauth.md)). The **internal** probe
must be `200`.

Assert the JSON-RPC response (which arrives as an SSE frame beginning
`data: {...}`) contains all expected tool names:

- `get_recent_activity`
- `get_sync_status`
- `diagnose_sync_health`
- `search`
- `get_thread`
- `list_threads`
- `list_accounts`
- `find_events`
- `get_event`
- `get_event_transcript`
- `get_steering`
- `add_steering_rule`
- `remove_steering_rule`
- `set_steering_enabled`

Any missing name = a registration regression. A `401` on the **internal**
port = bearer mismatch; re-check [.env](../../../.env). Any `415` = `Accept` header
wrong in the curl above. Any connection refused = the server crashed on
boot — read `/tmp/waldo-smoke-boot.log` before going further.

## Step 4 — Teardown

```sh
rm -f "$SMOKE_DB" "$SMOKE_DB-wal" "$SMOKE_DB-shm" /tmp/waldo-smoke-boot.log /tmp/waldo-smoke-body.txt
```

## Step 5 — Report

Post one short summary in chat:

```
/local-smoke PASS
- CLI: add x2, list, disable, remove, validation errors, no-op remove — all expected output
- Boot: listened on $SMOKE_PORT, tools/list returned all 14 tools
- Teardown: throwaway artifacts removed
```

On FAILURE: report the step that failed, the expected-vs-actual, and —
critically — **do not continue to `/deploy-local`**. Smoke failures are
boot-path or wiring regressions, and they always reach production if
you ship past them.
