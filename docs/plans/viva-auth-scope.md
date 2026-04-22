# Plan: Add `Community.Read.All` to MSAL scope list

## Task

Make the Viva Engage source actually work end-to-end against a real tenant
by requesting the `Community.Read.All` delegated permission during MSAL
device-code login and silent token refresh.

## Context — why this is needed

The [add-viva-engage-source](done/add-viva-engage-source.md) slice landed
all the plumbing (schema V12, store, HTTP client, sync function, scheduler
wiring, CLI flags, docs) but the MSAL scope list at
[src/auth/msal-auth-client.ts:11](../../src/auth/msal-auth-client.ts#L11)
was never updated:

```ts
const SCOPES = ["Mail.Read", "Chat.Read"] as const;
```

[docs/setup.md §2 step 6](../setup.md) tells the operator to grant
`Community.Read.All` in the Entra app registration, and the Entra side is
correct — but the runtime never **requests** that scope, so device-code
login issues a token without it. The first call `syncViva` makes to
`/beta/employeeExperience/communities/<id>/threads` will return **403
Forbidden**, and `--viva-discover` / `--viva-subscribe` will likewise fail
the moment they hit Graph.

Net effect: the plumbing is plumbing-complete, but the feature is
auth-blocked end-to-end.

## Scope boundary

**In scope:**
1. Add `"Community.Read.All"` to the `SCOPES` constant in
   [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts).
2. Update the two existing MSAL tests that hard-code the expected scope
   list (`getTokenSilent` + `loginWithDeviceCode`) to assert the new
   three-scope list.
3. Update operator-facing docs ([docs/setup.md](../setup.md),
   [docs/user-guide.md](../user-guide.md)) so re-consent is the explicit
   expected behaviour after deploy: existing accounts must run
   `--add-account` again to grant the new scope. MSAL detects the missing
   scope and re-prompts automatically — no special flag needed.
4. Changelog entry, security scan, plan archive.

**Out of scope** (deliberately deferred — flag if discovered, do not silently expand):
- Splitting scopes per source (e.g. requesting only `Community.Read.All`
  for a Viva-only account). All accounts get all three scopes today; that's
  fine because the tokens are local-only and read-only.
- A separate `--reauth` command. `--add-account <username>` already works
  as the re-consent entry point because MSAL silent acquisition fails when
  the cached token lacks a requested scope, which then forces device-code
  re-consent on the next add-account call.
- Per-account scope tracking in `accounts.json` or any DB column.
- Wiring `--viva-discover` to Graph — already done in the previous slice
  (verified at [src/cli.ts:387,409](../../src/cli.ts#L387)).
- Any change to Viva sync behaviour, scheduler logic, or the V12 schema.
- Conditional Access prompts. If a tenant's CA policy blocks
  `Community.Read.All`, that's a tenant-policy issue, not a code fix.

## Files to create / touch

- **Edit** [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts)
  — single-line change to the `SCOPES` constant.
- **Edit** [src/auth/msal-auth-client.test.ts](../../src/auth/msal-auth-client.test.ts)
  — two assertions update from `["Mail.Read", "Chat.Read"]` to
  `["Mail.Read", "Chat.Read", "Community.Read.All"]` (lines 128 and 191
  per current grep). Also add **one new RED test** that explicitly
  asserts `Community.Read.All` is in the scope list — this is the
  regression guard for "future me forgets again when adding the next
  source".
- **Edit** [docs/setup.md](../setup.md) — under §2 step 6, the
  `Community.Read.All` line is already there. Add a short note that
  consent is granted at first `--add-account`, and that **existing
  accounts must re-run `--add-account <username>` after upgrading** to
  pick up the new scope.
- **Edit** [docs/user-guide.md](../user-guide.md) — in the "Subscribing
  to Viva Engage communities" section, prepend a one-paragraph "First
  time on this version?" note pointing to the re-consent step.
- **Edit** [docs/changelog.md](../changelog.md) — entry under today's
  date.
- **Move** this plan to `docs/plans/done/viva-auth-scope.md` via
  `/docs-update` archive step.

## Seams involved

`msal` only. No graph, store, clock, fs, http, or logger changes.

## RED test list

The task is small enough that one new test plus two assertion updates is
the full RED list.

- **AC1**: `MsalAuthClient.getTokenSilent` requests
  `Community.Read.All` alongside `Mail.Read` and `Chat.Read`.
  - test file: [src/auth/msal-auth-client.test.ts](../../src/auth/msal-auth-client.test.ts)
  - test name update: `"getTokenSilent requests Mail.Read + Chat.Read +
    Community.Read.All scopes and returns AccessToken"` (rename existing)
  - seams touched: msal
  - edge cases: order matters in the assertion (toEqual is strict on
    array order); confirm MSAL accepts the three-scope array — it does
    (no change in API contract).

- **AC2**: `MsalAuthClient.loginWithDeviceCode` requests the same
  three scopes.
  - test file: [src/auth/msal-auth-client.test.ts](../../src/auth/msal-auth-client.test.ts)
  - test name update: `"loginWithDeviceCode requests Mail.Read +
    Chat.Read + Community.Read.All scopes via device code flow"` (rename
    existing)
  - seams touched: msal
  - edge cases: same as AC1.

- **AC3** *(new test, regression guard)*: the exported / module-level
  scope list contains `Community.Read.All`. This is a meta-assertion so
  that adding a fourth scope later doesn't accidentally drop one of the
  required ones.
  - approach: either export `SCOPES` from msal-auth-client.ts (cheap,
    minimal change) **or** assert via a fresh fake-pca round-trip.
    Prefer the **export** approach so the meta-test reads as
    `expect(SCOPES).toContain("Community.Read.All")` — clearer intent,
    decouples the regression guard from the call-path tests.
  - test file: [src/auth/msal-auth-client.test.ts](../../src/auth/msal-auth-client.test.ts)
  - test name: `"SCOPES includes Mail.Read, Chat.Read, and
    Community.Read.All"`
  - seams touched: none (pure module assertion)
  - edge cases: none.

## Open questions / assumptions

1. **Assumption**: `Community.Read.All` is the correct delegated
   permission for the `/beta/employeeExperience/communities/*/threads`
   endpoint, per [docs/setup.md §2](../setup.md) and the
   [add-viva-engage-source plan](done/add-viva-engage-source.md). Not
   re-verifying against MS Learn in this slice — the previous slice
   already confirmed it.
2. **Assumption**: re-consent happens automatically when MSAL's silent
   acquisition fails on the missing scope. waldo (the user) prefers a
   manual `--add-account <username>` re-run to keep the consent surface
   explicit; the docs will say so. **No** automatic re-consent prompt
   inside silent acquisition path.
3. **Assumption**: Conditional Access policies that block
   `Community.Read.All` for some tenants are out of scope. If
   waldo's iFacto / Dynex / personal accounts hit a CA prompt, that's a
   one-shot device-code consent, not a code change.
4. **Question for the operator**: does any account in
   `data/auth/accounts.json` need to be removed and re-added, or can
   `--add-account <username>` be re-run idempotently to upgrade the
   scope? Current understanding: re-running `--add-account` with the same
   username is the right move — MSAL device-code returns a new token
   covering the requested scopes, refreshes the cache, and the existing
   account row is unchanged. If wrong, surface in chat before shipping.

## Risks

- **Risk**: a tenant admin has not pre-consented `Community.Read.All`
  for the multitenant app, and the user is not a tenant admin in their
  own right. → device-code flow shows an admin-consent-required prompt
  for that account. Mitigation: docs explicitly call this out as a
  tenant-policy matter, not a code regression.
- **Risk**: the new scope changes behaviour of *existing* token cache
  entries in `data/auth/token-cache.json` on the NAS (next silent
  refresh fails because token doesn't cover the requested scope). →
  MSAL handles this gracefully — silent acquisition throws, our code
  raises `AuthError("silent-failed")`, and the next sync tick logs an
  error row. Operator runs `--add-account <username>` once per account
  to re-consent. **Acceptable** because the scope change is the whole
  point of the slice, and the operator knows it's coming.
- **Risk**: someone runs `/deploy-nas` without re-adding accounts, then
  is confused why `--viva-subscribe` works (CLI uses live device-code) but
  the scheduled sync logs auth errors. → docs clearly say "re-add
  accounts after upgrade".
- **Risk**: a flaky test that reads the SCOPES constant assumes a
  specific order. → use `toEqual` with the explicit three-element array
  for the call-path tests, and `toContain` for the meta-test.

## Out-of-scope follow-ups

- A future slice could add `--reauth <username>` as an explicit alias for
  "rotate the token cache for this account". Today, `--add-account` is
  the dual-use entry point.
- A future slice could add a startup probe that detects token-cache
  scope mismatches and logs a warning row pointing the operator at the
  `--add-account` workflow before the first sync tick errors.
- Per-account scope sets (e.g. a Viva-free account that only needs
  Mail.Read) — only worth doing if the operator ever has a tenant where
  `Community.Read.All` cannot be granted.

## Definition of done

- All three ACs have a named test, all green.
- `npm test -- --coverage` passes the 90% gate.
- `/security-scan` PASS — no real account identifiers added; the test
  fixtures already use synthetic ones.
- `/docs-update` PASS — changelog entry, setup.md re-consent note,
  user-guide.md re-consent note, plan archived to
  `docs/plans/done/viva-auth-scope.md`.
- Operator runs `/local-smoke` after the cycle and `/deploy-nas` to
  ship. **Not part of the coding-task DoD** — those are separate
  operator workflows.
- Operator re-runs `--add-account` for every account that should sync
  Viva. Verify by tailing `docker compose logs` and watching for a
  successful `viva-engage` row in `sync_log`.
