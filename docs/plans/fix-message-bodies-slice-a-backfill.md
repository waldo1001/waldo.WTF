# Fix message bodies — Slice A: HTML→text backfill + FTS rebuild

## Goal

Make message body content actually readable and searchable through the MCP
surface. Today Outlook mails land in `messages.body_html` only; the plain
`body` column is NULL, which breaks both FTS5 indexing (column 0 is `body`)
and the `snippet` projection (falls back to raw HTML → `<head><meta><style>`
garbage). This slice fixes existing rows **in place** on the production
882 MB lake without re-fetching from Graph, and stops the bug for new
mails going forward.

Slice B (exposing full bodies through `get_thread` / `get_message`) is a
separate plan — this slice is strictly about populating `body` and rebuilding
the FTS index.

## Scope boundary

**In scope:**
- New dep: `node-html-parser` (proper HTML parser, handles malformed markup).
- New helper `src/text/html-to-text.ts` with `htmlToText(html: string): string`.
- Mapper change in [src/sync/sync-inbox.ts](../../src/sync/sync-inbox.ts):
  when Graph sends `contentType: "html"`, populate **both** `bodyHtml`
  (verbatim) and `body` (`htmlToText(bodyHtml)`). Plain-text mails unchanged.
- New schema migration v5 → v6: no column changes; a migration marker only,
  so the backfill can be gated on `user_version >= 6` and re-run is idempotent.
- Backfill routine `src/store/backfill-body-from-html.ts`:
  - Chunked transactions (5 000 rows per tx) to keep WAL bounded.
  - `SELECT rowid, body_html FROM messages WHERE body IS NULL AND body_html IS NOT NULL`.
  - `UPDATE messages SET body = ? WHERE rowid = ?`.
  - Progress callback (count processed / total) for CLI visibility.
  - Self-healing: the `WHERE body IS NULL` predicate makes re-runs safe.
- FTS5 rebuild after backfill: `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`
  — official FTS5 incantation, rebuilds the shadow tables from the content
  table in place. Does not touch `messages`.
- CLI entrypoint: extend [src/cli.ts](../../src/cli.ts) with a
  `--backfill-bodies` subcommand that opens the real DB, runs the backfill
  with progress output, runs the FTS rebuild, and reports counts.
- Docs: update [docs/user-guide.md](../../docs/user-guide.md) +
  [docs/changelog.md](../../docs/changelog.md) with a "run this once after
  upgrading" operator note.

**Out of scope:**
- Any change to `get_recent_activity`, `search`, `get_thread`, or
  `get_message` projections. They continue to project `snippet` only. The
  snippet quality improves automatically once `body` is populated because
  `snippetFrom()` prefers `body` over `bodyHtml`.
- Any change to Teams sync (Teams messages already land with plain `body`).
- Any change to `raw_json` — it stays as the untouched insurance copy.
- New MCP tools (`get_message`, `include_body` flag). Slice B.
- Re-downloading anything from Graph. The delta tokens are untouched.
- WhatsApp. No HTML there.

## Files to touch

- `package.json` — add `node-html-parser` (runtime dep).
- `src/text/html-to-text.ts` — **new**, the pure helper.
- `src/text/html-to-text.test.ts` — **new**, RED tests.
- `src/sync/sync-inbox.ts` — mapper populates `body` from HTML.
- `src/sync/sync-inbox.test.ts` — add cases for HTML-only and HTML+text mapping.
- `src/store/schema.ts` — add `MIGRATION_6` (marker, no DDL beyond
  `PRAGMA user_version=6`) + wire into the migration ladder.
- `src/store/schema.test.ts` — v5 → v6 upgrade test, idempotence.
- `src/store/backfill-body-from-html.ts` — **new**, the chunked backfill.
- `src/store/backfill-body-from-html.test.ts` — **new**, covers:
  empty db, mixed NULL/non-NULL `body`, re-run idempotence, chunk boundary
  (>5 000 rows), FTS index reflects backfilled bodies after rebuild.
- `src/cli.ts` — `--backfill-bodies` wiring.
- `src/cli.test.ts` — subcommand dispatch test.
- `docs/user-guide.md`, `docs/changelog.md` — operator note.

## Seams

The backfill takes a `Database` handle (better-sqlite3) and an
`htmlToText: (html: string) => string` function by injection. Tests use
the real `better-sqlite3` `:memory:` (schema tests already do this) and
the real `htmlToText`. No mocks — the helper is pure, the DB is embeddable.
No clock, no fs, no network.

The `htmlToText` helper is a pure function:

```ts
export function htmlToText(html: string): string
```

Contract:
- Strip `<script>`, `<style>`, `<head>` element *contents* entirely.
- Preserve text content of all other tags.
- Decode named + numeric HTML entities (`&amp; &nbsp; &#39; &#x27;`).
- Convert `<br>`, `<p>`, `<div>`, `<li>`, `<tr>` to single `\n` so paragraphs
  survive as line breaks.
- Collapse runs of whitespace (including NBSP) to single spaces within a
  line; trim each line; drop leading/trailing blank lines; collapse
  3+ consecutive blank lines to 2.
- Return `""` on `""` / whitespace-only / tag-only input.
- Must not throw on malformed HTML (this is `node-html-parser`'s job — the
  whole reason we picked "proper" over regex).

## RED test list

### `html-to-text.test.ts`
1. empty string → `""`
2. plain text (no tags) → unchanged modulo whitespace collapse
3. `<p>hello</p><p>world</p>` → `"hello\n\nworld"` (or similar, with newline
   between paragraphs)
4. `<br>` inside a paragraph → newline
5. `<script>alert(1)</script>visible` → `"visible"` (script contents dropped)
6. `<style>.x{}</style>visible` → `"visible"`
7. `<head><title>t</title></head><body>b</body>` → `"b"`
8. entity decoding: `&amp; &lt; &gt; &quot; &#39; &nbsp;` → literal chars
9. numeric + hex entities: `&#8211; &#x2013;` → `–`
10. malformed: `<p>hello<p>world` → does not throw, returns reasonable text
11. real Outlook sample fixture (200-line HTML email, committed as
    `fixtures/outlook-sample.html`) → plain text with no angle brackets, no
    `{`/`}` CSS remnants, subject-matter text intact.
12. whitespace collapse: `"a    b\n\n\n\nc"` style input → no runs of 3+
    blank lines, no multi-space runs inside a line.

### `sync-inbox.test.ts` (additions)
13. Graph message with `body.contentType="html"` → resulting `Message` has
    both `bodyHtml` (raw) and `body` (stripped plain text).
14. Graph message with `body.contentType="text"` → `body` only, no `bodyHtml`
    (unchanged behavior).
15. Graph message with no body → neither field set (unchanged).

### `schema.test.ts` (additions)
16. Fresh db migrates to v6; `user_version = 6`.
17. v5 → v6 upgrade on a db with existing rows: rows survive, FTS index
    survives, `user_version` advances.

### `backfill-body-from-html.test.ts`
18. Empty db: runs without error, reports `{processed: 0}`.
19. Mixed rows (some `body` already populated, some NULL with HTML, some
    NULL with no HTML): only the NULL-with-HTML rows are touched; counts
    match.
20. Re-run is a no-op (reports 0 processed second time).
21. Chunk boundary: 12 001 rows → three transactions, all rows populated.
22. FTS rebuild after backfill: `SELECT rowid FROM messages_fts WHERE
    messages_fts MATCH 'specificword'` returns the row whose HTML contained
    `specificword` buried inside `<span>`. Before backfill: 0 hits. After:
    1 hit.

### `cli.test.ts` (additions)
23. `runCli(["--backfill-bodies"])` dispatches to the backfill with the
    real DB path from config, reports processed count on stdout, exit 0.
24. Unknown subcommand → exit 1 (regression guard, already tested).

## Risks & mitigations

- **R1: `node-html-parser` bundle bloat or native-dep surprise on arm64
  Synology container.** Mitigation: it's pure JS, no native bindings — safe
  for the `node:22-bookworm-slim` image without extra `apt` packages. Verify
  by grepping `node_modules/node-html-parser` for `.node` files after install.

- **R2: Backfill blows up WAL on the 882 MB production lake.** Mitigation:
  chunked 5 000-row transactions + explicit `PRAGMA wal_checkpoint(TRUNCATE)`
  after each chunk. Manual pre-step in the operator note: snapshot
  `lake.db` with `cp` first.

- **R3: `htmlToText` produces subtly-wrong plain text that then gets
  FTS-indexed and we can't easily tell.** Mitigation: the real Outlook
  fixture test (case 11) exercises an actual mail. And the backfill is
  re-runnable at any time from `body_html` — we can always re-strip with a
  better algorithm later without re-fetching from Graph.

- **R4: Production lake is in use by the running container during backfill.**
  Mitigation: operator note says "stop the container, run backfill against
  the volume, start container again". The backfill CLI takes an exclusive
  write handle anyway (better-sqlite3 default).

- **R5: FTS5 `rebuild` on the full index over ~36 000+ messages takes "a
  while".** Mitigation: it's a one-shot operator action, not a user-facing
  latency concern. Document expected duration after local measurement.

- **R6: Migration v6 is a no-op marker — feels wrong.** Mitigation: this is
  deliberate. The backfill is a *data* migration, not a *schema* migration,
  and gating it on `user_version >= 6` makes re-runs free and lets future
  code assume v6+ rows have `body` populated when `body_html` is present.
  The marker is the contract.

## Definition of done

- All RED tests pass; coverage ≥90% line + branch on every touched file.
- `/security-scan` clean (no fixtures with real tenant data; HTML fixture
  is synthetic).
- `/docs-update` run — changelog + user-guide entry for the one-shot
  operator step.
- Manual smoke on a copy of the real 882 MB lake:
  1. `cp lake.db lake.db.pre-backfill`
  2. `tsx src/cli.ts --backfill-bodies`
  3. Observe processed count, wall-clock time, final DB size, no errors.
  4. `sqlite3 lake.db "SELECT COUNT(*) FROM messages WHERE source='outlook' AND body IS NULL"` → 0.
  5. FTS spot check: search for a rare word known to be in one specific
     mail body, confirm hit.
  6. Restart container, run `search` via MCP, confirm `snippet` is no
     longer null and no longer looks like `<html><head>…`.
- PROGRESS.md gets a new entry under a "Weekend 5.5 — Body backfill" section.

## Out-of-scope (explicitly deferred to Slice B)

- `include_body` parameter on `get_thread` / `search` / `get_recent_activity`.
- New `get_message(id)` tool.
- Any projection change. Slice A only improves the existing snippet quality
  as a side effect of populating `body`.
