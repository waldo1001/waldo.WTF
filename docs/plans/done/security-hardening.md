# Security hardening — umbrella plan

Status: **DONE 2026-10-12** — S1–S4 committed on `security/hardening`; not deployed (operator steps below).
Branch: `security/hardening` (no deploy; stop when green + `/local-smoke` + committed).

## Why

Production is exposed through **Tailscale Funnel**, not tailnet-only Serve:
`https://<host>.ts.net` forwards to `127.0.0.1:8765`. Every route is reachable from
the internet, the repo is public, and the hostname is in public docs. Goal: nobody
but waldo reaches the lake. The MCP surface stays read-only.

## Clients that must keep working (verified, not assumed)

| Client | How it authenticates today | Path |
|---|---|---|
| claude.ai web | OAuth (DCR + PKCE), Anthropic cloud → **Funnel** | `claude.ai` connector "waldo-wtf" |
| Claude mobile | the **same** claude.ai connector (cloud-side) | Funnel |
| Claude Desktop (laptop) | the **same** claude.ai connector; no local `mcpServers` entry | Funnel |
| Claude Code in the Jarvis repo | `.mcp.json` `waldo-wtf` = `https://<host>.ts.net/mcp`, **no headers** → Claude Code's own OAuth (localhost callback) | Serve/Funnel |
| **Jarvis watchers/leader** (Mac mini, pm2) | **static bearer** `JARVIS_WTF_MCP_TOKEN` → `https://<host>.ts.net/mcp` | through Serve/Funnel |

**Jarvis is the only static-bearer consumer.** Every other client uses OAuth.
Because Funnel is required for the claude.ai cloud connector (Anthropic egress
cannot reach a tailnet-only host), the fix is to **harden OAuth for the public
path and move the static bearer off the public path**. Turning Funnel off would
break the phone and claude.ai.

## Findings — verification against the code

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1a | DCR accepts any https redirect_uri; client_name shown, redirect not | **Confirmed** | `src/auth/oauth/dcr.ts` `isAllowedRedirectUri` (`https:` → true); `authorize.ts` `consentForm` shows name + client_id only |
| 1b | Authorize POST does not re-check client/redirect/PKCE | **Confirmed** | `handleAuthorizePost` checks only the password, then `saveAuthCode` with whatever the form posted |
| 2a | Static bearer bypasses OAuth over Funnel | **Confirmed** | `http-server.ts` `checkAuthorization` falls back to `isAuthorized(static)` unless `disableStaticBearer` |
| 2b | `.claude/settings.local.json` holds the bearer, not ignored | **Partly.** The repo `.gitignore` doesn't list it, but waldo's **global** git ignore does. `git log --all` shows it was **never committed**. No leak. Still add both entries to the repo `.gitignore` (other clones/machines). |
| 3 | No body caps / rate limits / client cap | **Confirmed** | `readJsonBody`/`readRawBody` read unbounded; no limiter; `registerClient` unbounded |
| 3+ | **New:** route handlers run as `void (async () => …)()` with no try/catch, and there is no `unhandledRejection` handler in `src/` | **Confirmed.** Any throw, e.g. an SQLite error or an FK violation from a bogus `client_id` in authorize POST (`oauth_auth_codes.client_id REFERENCES oauth_clients`), becomes an unhandled rejection. That can kill the process (launchd restarts it), so it's a cheap DoS. |
| 4 | Plaintext tokens, sliding 30-day refresh → immortal | **Confirmed** | `sqlite-auth-store.ts` stores raw values; `refreshAccessToken` slides `refresh_expires_at` forever. Auth codes are plaintext too. |
| 5a | No security headers on HTML | **Confirmed** | `writeHtml` sets only Content-Type/Length |
| 5b | Token endpoint ignores client_id | **Confirmed** | `token.ts` never reads `body.client_id`; refresh is not bound to a client either |
| 5c | Error pages echo input | **Low.** It's escaped (`escHtml`), but `unknown client: <id>` and `redirect_uri '<uri>'` reflect attacker text. Replace with fixed messages. |
| 6a | `deploy-macmini.md` says "tailnet-only (not Funnel)" | **Confirmed wrong** |
| 6b | `/deploy-local` step 6 re-asserts **`serve`**, not Funnel | **Confirmed mismatch.** `.claude/skills/deploy-local/SKILL.md:36-38` |

Calibration: the static bearer and admin password are high-entropy random hex,
so online brute force isn't the realistic threat. Rate limiting is mainly
**DoS protection** (scrypt CPU, DB growth). The realistic **compromise** paths
are consent phishing (#1) and a leaked bearer (#2), so those go first.

## Slices (reordered vs. the prompt)

| Slice | Sub-plan | Covers | Why this order |
|---|---|---|---|
| S1 | [security-hardening-s1-oauth-flow-integrity.md](security-hardening-s1-oauth-flow-integrity.md) ✅ | #1, #5a/b/c | The only realistic remote takeover path. #5 is folded in because it touches the same handlers and pages. A separate slice would churn the same files twice. |
| S2 | [security-hardening-s2-static-bearer-off-public-path.md](security-hardening-s2-static-bearer-off-public-path.md) ✅ | #2 | Removes the non-expiring credential from the internet. Needs a coordinated Jarvis env change. |
| S3 | [security-hardening-s3-abuse-limits.md](security-hardening-s3-abuse-limits.md) ✅ | #3 + new crash finding | DoS / resource exhaustion |
| S4 | [security-hardening-s4-token-storage-lifetime.md](security-hardening-s4-token-storage-lifetime.md) ✅ | #4 + revoke CLI | Schema migration; the riskiest change, so it goes last when everything else is green |
| — | (docs, inside each slice's `/docs-update`) | #6 | Not a code slice |

Each slice: FRAME → RED → … → COVER (≥90%) → `/security-scan` → `/docs-update` → REVIEW → commit on the branch.
After S4: `/local-smoke`, then stop.

## Decisions (answered 2026-10-12)

1. **Static bearer strategy (S2): option A chosen.** a **second loopback-only listener**
   (`127.0.0.1:8766`, never Served/Funnelled) that accepts *only* the static bearer.
   The public listener on `:8765` becomes OAuth-only. Jarvis repoints to
   `http://127.0.0.1:8766/mcp`. No trust in forwarded headers, so it doesn't depend
   on undocumented Funnel header behavior. Alternatives are in the S2 sub-plan.
2. **Absolute token lifetime (S4): 180 days** (`WALDO_OAUTH_MAX_GRANT_DAYS` default 180).
   Re-consent on claude.ai twice a year; one consent covers web, mobile and Desktop.
3. **Hostname scrub: docs only.** Replace the real `*.ts.net` host in public docs with
   `<host>.ts.net`? It occurs in 8 tracked files, including `bin/wtf-whatsapp-push`
   and a test. Git history keeps it regardless. Script + test keep functional values.
   Done in S1's `/docs-update`.

## Operator steps after deploy (you, not me)

Order matters. The internal listener only exists after the deploy, so Jarvis
switches **right after** it (Jarvis misses at most one sweep, and fails loudly
rather than silently, per Jarvis spec 605):

0. **Backup first** (the v20 migration hashes tokens one-way):
   `sudo launchctl kickstart system/com.waldo.wtf.backup` and wait for `backup.log`.
1. **waldo.WTF `.env`**: add `WALDO_INTERNAL_PORT=8766` (check `lsof -i :8766` is free first).
   Optional: `WALDO_OAUTH_MAX_GRANT_DAYS` (default 180), `WALDO_OAUTH_MAX_CLIENTS` (default 50).
2. **Deploy** with `/deploy-local`. The S4 schema migration (v19 → v20) runs **automatically
   at boot**; pre/post-verify in [oauth-token-hashing](../../migrations/oauth-token-hashing.md).
   Log shows `internal MCP listener (static bearer only) on http://127.0.0.1:8766`.
   **Then Jarvis** (`.env.jarvis` on the Mac mini): set
   `JARVIS_WTF_MCP_URL=http://127.0.0.1:8766/mcp` and restart it via pm2.
3. **Rotate secrets** in `/Users/waldo/waldo-wtf/.env` (I will not touch it):
   - `BEARER_TOKEN=$(openssl rand -hex 32)`, and put the same value in Jarvis's `JARVIS_WTF_MCP_TOKEN`
   - `WALDO_ADMIN_PASSWORD=$(openssl rand -hex 24)`
   - `sudo launchctl kickstart -k system/com.waldo.wtf.server`, then `pm2 restart` the Jarvis processes
4. **Clients (one action, recommended):** the connector keeps working after deploy
   (tokens are hashed in place), but pre-S4 NAS backups still contain those same
   tokens in plaintext. Make them useless:
   - `npx tsx src/cli.ts --list-oauth-clients` → note the current client id(s).
   - claude.ai → Settings → Connectors → **remove and re-add** waldo-wtf, approve
     the consent (now showing "sent to: https://claude.ai"). This one consent
     covers claude.ai web, Claude mobile **and** Claude Desktop (all use the same
     connector). Desktop: quit with Cmd+Q and relaunch afterwards ([oauth.md §6.1](../../oauth.md)).
   - `--revoke-oauth-client <old id>` for the old registration(s) and anything else you
     don't recognise (especially a redirect host that isn't claude.ai/claude.com/loopback).
   - Claude Code in the Jarvis repo: `/mcp` → re-authenticate if prompted.
   - From then on: re-add the connector about every 180 days (the grant cap).
5. **Verify**: `curl https://<host>.ts.net/health` → 200; `/mcp` without auth → 401;
   `/mcp` with the **static bearer** over the ts.net URL → **401** (proves S2);
   a Jarvis sweep succeeds; a tool call from your phone works.

## Out of scope

- Turning Funnel off, or path-filtering Funnel (claude.ai needs `/mcp`, `/oauth/*`, `/.well-known/*`).
- Rotating secrets or editing `.env` myself; deploying.
- Encrypting `lake.db` / NAS backups at rest (the message content itself). Worth a separate threat-model pass.
- Jarvis code changes. Only its env value changes. If you prefer a code default change (`DEFAULT_WTF_MCP_URL`), that's a Jarvis spec.
