# Hotfix — consent page CSP blocks the redirect back to claude.ai

## Task
Let the browser follow the post-approval 302 to the client's validated
redirect origin while keeping `form-action` restrictive.

## Evidence (production, 2026-10-12)
After the S1 deploy, re-adding the claude.ai connector failed: DCR succeeded
(14:53:58Z), the admin password was accepted three times (auth codes minted
14:54:05/16/38Z), but no token exchange ever happened. S1 sends
`Content-Security-Policy: … form-action 'self'` on the consent page; Chrome
applies `form-action` to redirects that follow a form submission, so the 302
to `https://claude.ai/api/mcp/auth_callback` was blocked. `/local-smoke` used
curl, which ignores CSP.

## Scope
- IN: consent page (GET 200) and wrong-password re-render (POST 401) get a
  per-request CSP whose `form-action` is `'self' <validated redirect origin>`.
  Error pages keep `form-action 'self'` (they have no form).
- OUT: any other header change; client-side retries.

## Files
`src/mcp/http-server.ts`, `src/mcp/http-server.test.ts`, docs (changelog, oauth.md).

## Seams
http.

## RED tests
1. Consent GET for a claude.ai client → CSP `form-action 'self' https://claude.ai`.
2. Wrong-password 401 page → same origin allowed.
3. Loopback client (`http://127.0.0.1:53682/cb`) → `form-action 'self' http://127.0.0.1:53682`.
4. Error page (unknown client) → `form-action 'self'` only.

## Risks
Only an origin that has already passed validation (registered and allowlisted)
reaches the header, so header injection isn't possible: the value comes from
`new URL().origin`.

## Out-of-scope follow-up
`/local-smoke` can't see browser-only policies (CSP). Worth a headless-browser
consent check in the smoke at some point.
