---
name: security-scan
description: Scan the workspace for secrets, credentials, PII, and common security leaks. Runs as a mandatory step in every /tdd-cycle (after COVER, before UPDATE DOCS) and also on-demand when the user asks for a security check. Blocks the cycle if anything is found — never "note and continue".
---

# /security-scan — waldo.WTF security leak checker

waldo.WTF holds refresh tokens for multiple Microsoft tenants plus message
bodies from customer-tenant guest accounts. A leak here is not "a bug" — it's
a credential compromise or customer data exposure. This skill runs hard
checks on every cycle and **blocks completion** if anything suspicious is
found.

Reference: [../../../waldo.WTF-project-brief.md §9](../../../waldo.WTF-project-brief.md),
[../../../docs/tdd/ai-maintainability.md §9](../../../docs/tdd/ai-maintainability.md).

## When to run

- **Always** as part of `/tdd-cycle` (Step 10, between COVER and UPDATE DOCS).
- **Always** before any `git commit`, `git push`, or PR creation.
- **Always** when the user explicitly asks for a security check.
- **Always** after adding new fixtures, logs, or error messages.

## The rules (what MUST NOT exist in the repo)

1. **No secrets in tracked files.** Tokens, bearer strings, client secrets,
   passwords, API keys, connection strings, private keys, signed JWTs.
2. **No real tenant/account identifiers** outside documentation that
   intentionally names them (e.g. `PROGRESS.md`'s "dynex.be confirmed
   working" line is OK; a fixture containing `eric.wauters@dynex.be` is
   not).
3. **No real Microsoft Graph payloads** pulled from real inboxes. Every
   fixture is synthetic. Use `example.invalid`, `test.invalid`,
   `Alice`/`Bob` style names.
4. **No sensitive files tracked.** `.env`, `token-cache.json`,
   `accounts.json`, `lake.db`, `lake.db-wal`, `lake.db-shm`, any `*.pem`,
   `*.key`, `*.pfx`, `*.p12`.
5. **No logging of secrets.** Tokens, bearer strings, or raw Graph
   payloads containing message bodies must never appear in
   `logger.info/warn/error` calls.
6. **No message bodies in snapshots.** Vitest snapshots must not contain
   real or fixture body text beyond bland placeholders.
7. **No secrets in error messages.** `throw new Error(\`... \${token}\`)`
   is a leak waiting to be logged.
8. **No secrets in comments or TODOs.** Especially `// temp: ABC123...`.

## Step 0 — Refresh the gitignore baseline

Before scanning, verify [`../../../.gitignore`](../../../.gitignore) exists
and contains at least:

```
.env
.env.*
!.env.example
token-cache.json
accounts.json
data/
lake.db
lake.db-*
*.pem
*.key
*.pfx
*.p12
node_modules/
coverage/
.vscode/settings.json
```

If the file is missing or any rule is absent, add it before proceeding.
This is the cheapest and highest-leverage defense.

## Step 1 — Is anything sensitive currently staged or tracked?

Run:

```sh
git ls-files | grep -E '(^|/)(\.env($|\.)|token-cache\.json|accounts\.json|.*\.pem|.*\.key|.*\.pfx|.*\.p12|lake\.db)'
```

Expected output: **empty**. Any hit = immediate block. If a sensitive file
is already tracked, the fix is:

1. `git rm --cached <file>` — stop tracking, keep local copy.
2. Add to `.gitignore`.
3. **Rotate the secret** — assume git history is compromised the moment a
   credential touched a tracked file. Regenerate client secrets, bearer
   tokens, refresh-token cache. Do not skip this step because "I didn't
   push yet" — local git history is still recoverable.
4. If the file was ever pushed, consider the repo history tainted and
   rewrite with `git filter-repo` (and force-push only after confirming
   with the user — see CLAUDE.md "executing actions with care").

## Step 2 — Pattern scan for secrets in source

Run these Grep patterns across the whole workspace (excluding
`node_modules/`, `coverage/`, `data/`, `.git/`). Any match is a block.

**High-entropy and credential shapes:**

- `(?i)(api[_-]?key|secret|token|password|passwd|bearer)[^a-z0-9]{1,5}['"][a-z0-9+/=_-]{16,}['"]`
  — assignment of a suspiciously long string to a secret-named var.
- `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`
  — JWT (signed).
- `-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----`
  — PEM private key.
- `(?i)client[_-]?secret\s*[:=]\s*['"]\S{8,}['"]`
  — Entra/OAuth client secret.
- `(?i)aws(.{0,20})?(access|secret)[_-]?key` — AWS, shouldn't exist here.
- `0x[a-f0-9]{40,}` — long hex string; inspect every hit.
- `[a-f0-9]{64}` — sha256-sized hex; verify it's a hash not a secret.

**Microsoft-specific shapes:**

- GUIDs near the word `tenant`, `client`, or `app` — inspect; GUIDs
  themselves aren't secret but the pairing with a secret nearby is a
  smell.
- `login\.microsoftonline\.com` with a hardcoded tenant ID — acceptable
  in docs, suspicious in source (should be `common` or from config).

**Environment variable leakage:**

- `process\.env\.[A-Z_]+` outside [`../../../src/config.ts`](../../../src/config.ts)
  — violates the config-at-boundary rule
  ([ai-maintainability §5](../../../docs/tdd/ai-maintainability.md)) and
  is a common leak path.

## Step 3 — Real-data scan

Grep for known real identifiers that must NEVER appear in tracked
files outside the project brief / PROGRESS / README / setup docs:

- `eric\.wauters@`
- `@dynex\.be`
- `@ifacto\.be`
- Real customer tenant domains (check with user if uncertain — never
  guess and commit).
- waldo's real phone number, real WhatsApp contact names, real family
  member first names.

**Allowed locations** (these docs name real identifiers on purpose):

- `README.md`
- `waldo.WTF-project-brief.md`
- `PROGRESS.md`
- `docs/setup.md`
- `docs/getting-started.md`

**Banned locations**: `src/**`, `testing/**`, fixtures, snapshots, tests,
changelog, user guide, any comment.

## Step 4 — Log hygiene scan

For every `logger.info|warn|error` call in `src/`:

- The first argument must be a snake_case event name string literal.
- The second argument must be a plain object with primitive values
  (string, number, boolean) only. No `rawPayload`, no `body`, no
  `token`, no `Authorization`, no `message.body`, no `msg.raw_json`.

Grep patterns:

- `logger\.(info|warn|error)\([^,]+,\s*\{[^}]*(token|body|authorization|raw|secret|password)`
  — any match = leak.

Also check: no `console.log`, `console.error`, etc. in `src/` outside
the composition root. `console.*` bypasses the structured logger and
can leak without going through log-redaction.

## Step 5 — Error-message scan

Grep for template literals in `throw new Error(...)` or
`new <TypedError>(...)` that interpolate variables matching secret
shapes:

- `\`[^\`]*\$\{.*token.*\}` inside `throw new Error`
- `\`[^\`]*\$\{.*secret.*\}` inside `throw new Error`
- `\`[^\`]*\$\{.*bearer.*\}` inside `throw new Error`
- `\`[^\`]*\$\{.*password.*\}` inside `throw new Error`

Error messages should name the *account/source/operation* (public), not
the *credential* (secret).

## Step 6 — Snapshot & fixture scan

- `src/**/__snapshots__/**` — open each snapshot file, scan for long
  strings, email addresses, JWTs. Snapshots are a sneaky leak vector
  because they're auto-generated and rarely reviewed line by line.
- `src/**/__fixtures__/**` — every fixture must use `example.invalid`,
  `test.invalid`, placeholder names. Any real-looking identifier is a
  block.

## Step 7 — Dependency advisory scan (when applicable)

Once `package.json` exists (Weekend 2+):

```sh
npm audit --audit-level=high
```

High or critical vulnerabilities block the cycle. `npm audit fix` only
if it doesn't introduce major version bumps — otherwise surface to the
user for a decision.

## Step 8 — Report

Post the result in chat, explicitly:

```
Security scan:
- Gitignore baseline: OK | FIXED | MISSING RULES <list>
- Tracked sensitive files: CLEAN | BLOCKED <list>
- Secret pattern scan: CLEAN | BLOCKED <file:line hits>
- Real-data scan: CLEAN | BLOCKED <file:line hits>
- Log hygiene: CLEAN | BLOCKED <file:line hits>
- Error-message interpolation: CLEAN | BLOCKED <file:line hits>
- Snapshots/fixtures: CLEAN | BLOCKED <file:line hits>
- npm audit (if applicable): CLEAN | <N high> <N critical>
Result: PASS | BLOCK
```

**Only on PASS** may the cycle continue to UPDATE DOCS. On BLOCK, fix
the findings and re-run the full scan — partial re-runs are not
permitted because a fix in one place can unmask a leak in another.

## Step 9 — On a real hit: rotation protocol

If a real secret is found in tracked files or history, rotation is
**not optional** and **not deferrable**:

1. Stop the cycle. Tell the user, in chat, exactly what was found and
   where.
2. Rotate the credential at the source (Entra portal for client
   secrets, regenerate bearer token, trigger re-login for any refresh
   tokens).
3. Remove the secret from the working tree AND from history if it was
   ever pushed (see Step 1 guidance).
4. Add a regression test or pattern to prevent recurrence (see
   [src/__meta__/seam-boundaries.test.ts](../../../docs/tdd/testability-patterns.md#5-anti-patterns-banned-in-this-repo)
   as the model for meta-tests).
5. Log the incident in [../../../docs/changelog.md](../../../docs/changelog.md)
   under today's date with a terse note — enough to remember, not
   enough to re-leak.

---

**Never "note and continue".** A found secret is a full stop. The cost
of pausing is a minute; the cost of a rotated production credential is
nothing compared to the cost of an un-rotated leaked one.
