# Weekend 6 — WhatsApp importer (+ Android wiring)

Status: **DRAFT — awaiting approval**. No code until acknowledged.

## Goal

Bring a third `source` into the lake: WhatsApp chats, imported from the
`.txt` files WhatsApp exports from the phone. Unlike Outlook/Teams there
is no API — this is a **file-driven importer**: user drops exports into
`~/Downloads/`, waldo.WTF parses, dedups, upserts into `messages`, moves
the file into a dated archive. Android/Tailscale/Claude-mobile wiring
is the non-code tail of the weekend and is tracked but not implemented
by the TDD loop.

## One-sentence test (brief §1)

*"Does this make 'wtf is going on in my life?' return a better answer?"*
— Yes: it folds the channel where waldo gets the most non-work pings
into the same triage surface Claude already uses for mail + Teams.

## Scope boundary

**In scope (coded, tested, shipped):**
1. Pure WhatsApp `.txt` parser — text in, `ParsedWhatsAppMessage[]` out.
2. Deterministic message id = `sha256(chat + sender + sentAtIso + body)`
   → `whatsapp:<hex>` (mirrors brief §7 dedup rule; survives re-imports).
3. `WhatsAppImporter` that maps parsed rows to `Message` and calls
   `MessageStore.upsertMessages` (which already uses `INSERT OR REPLACE`
   on primary key — effectively idempotent for our hashed ids).
4. Archive move: imported file → `~/WhatsAppArchive/YYYY-MM/<basename>`
   via the existing `FileSystem` seam (mkdir -p + rename). Never delete.
5. Chokidar-backed watcher **behind an injected `FileWatcher` seam** so
   tests use a fake. Real adapter is a thin `chokidar.watch` wrapper.
6. CLI subcommand `tsx src/cli.ts --import-whatsapp [--watch]` —
   one-shot mode (scan `~/Downloads/` once) and watch mode.
7. `src/index.ts` wiring: optional watcher started alongside the sync
   scheduler when a config knob is set (default **off** on the NAS —
   WhatsApp exports land on the Mac, not on the Synology).
8. MCP surface verification (no new tools): `get_recent_activity`,
   `search`, `get_thread` must project whatsapp rows cleanly.
   `thread_id` = chat name hash; `thread_name` = raw chat name.
9. Docs: [user-guide.md](../user-guide.md) export-from-phone recipe,
   [changelog.md](../changelog.md), a new
   [deploy-whatsapp-importer.md](../deploy-whatsapp-importer.md) if
   the wiring warrants it (decide at UPDATE DOCS step).

**Out of scope (explicit non-goals, per brief §1 and traps §8):**
- Live WhatsApp integration (Baileys / web scraping) — ban risk.
- Media attachments (images/voice). Parser skips `<Media omitted>` etc.
- Locale auto-detection — waldo's Mac locale is hardcoded, per brief §7.
- New MCP tools. v1 surface stays at 5 tools.
- Schema migration — `source` is already a free TEXT column.
- Android/Tailscale setup (manual ops, tracked in PROGRESS.md checklist
  but not part of the TDD cycle).

## Files to touch

New:
- `src/sources/whatsapp.ts` — types (`ParsedWhatsAppMessage`,
  `WhatsAppExport`), pure `parseWhatsAppExport(text, opts)`.
- `src/sources/whatsapp.test.ts` — RED-first parser tests.
- `src/sync/import-whatsapp.ts` — `importWhatsAppFile({fs, clock,
  store, archiveRoot, downloadsPath})`: read → parse → hash-id → upsert
  → archive. Returns `{imported, skipped, archivedTo}`.
- `src/sync/import-whatsapp.test.ts`
- `src/sync/whatsapp-watcher.ts` — `FileWatcher` seam + chokidar
  adapter + `startWhatsAppWatcher({watcher, importer, logger})`.
- `src/sync/whatsapp-watcher.test.ts` — fake watcher driving the loop.
- `src/testing/fake-file-watcher.ts` — scripted emit helper.
- Plan doc (this file).

Modified:
- `src/cli.ts` / `src/cli.test.ts` — `--import-whatsapp [--watch]`
  subcommand; one-shot runs the importer once against configured
  downloads path, watch mode wires the watcher.
- `src/config.ts` / `src/config.test.ts` — new knobs:
  `WALDO_WHATSAPP_DOWNLOADS_PATH` (optional, default
  `~/Downloads`), `WALDO_WHATSAPP_ARCHIVE_PATH` (optional, default
  `~/WhatsAppArchive`), `WALDO_WHATSAPP_WATCH` (bool, default false).
- `src/index.ts` / `src/index.test.ts` — when `WALDO_WHATSAPP_WATCH`
  is true, start watcher alongside `SyncScheduler`; on shutdown,
  close it.
- `src/fs.ts` — add `rename(src, dst)` if missing; keep the seam.
- `docs/user-guide.md`, `docs/changelog.md`, possibly
  `docs/deploy-whatsapp-importer.md`, PROGRESS.md.

## Seams (testability — per docs/tdd/testability-patterns.md)

- **Clock**: imported-at comes from injected `Clock`.
- **FileSystem**: all reads/writes/mkdir/rename go through `fs.ts`
  seam so tests never touch real disk.
- **FileWatcher**: new interface, `FakeFileWatcher` in tests.
- **MessageStore**: `InMemoryMessageStore` already exists — use it.
- **Parser is pure**: no seams, just text → objects.

## Dedup strategy

Message id: `"whatsapp:" + sha256Hex(chat + "\n" + sender + "\n" +
sentAtIso + "\n" + body)`. Produced by a new `hashWhatsAppId(parts)`
helper to keep a single source of truth. Re-importing the same export
produces identical ids → `upsertMessages` (INSERT OR REPLACE) is a
no-op for unchanged rows. Counted as `skipped` in the importer return
shape when the row already exists (detected by pre-check, since
`upsertMessages` doesn't return affected-row counts today — if adding
that to the contract is bigger than expected, downgrade to
"imported includes already-present rows" and note in FRAME).

## Slices (each a complete PLAN→FRAME→RED→…→REVIEW cycle)

The user asked for slice-per-slice TDD. Proposed order — each slice is
independently shippable and individually runs the full 10-step loop:

### Slice 1 — WhatsApp `.txt` parser (pure function)
- Types + `parseWhatsAppExport(text, {locale: "mac-en-be"})`.
- Handles: `[DD/MM/YYYY, HH:MM:SS] Sender: body`, multi-line
  continuations (prepend to previous), system messages (no `:` after
  sender — classify as `system`, default skip), `<Media omitted>`
  (skip), zero-width chars that Apple exports sometimes inject.
- RED tests: single message, multi-line, system message, media
  omitted, malformed line, empty file, BOM/ZWSP, locale-specific
  date parse.

### Slice 2 — `hashWhatsAppId` + `Message` mapping
- Tiny helper; RED tests lock the hash format and stability.
- Small mapper `toMessage(parsed, {chatName, account, importedAt})`.

### Slice 3 — `importWhatsAppFile` orchestrator (one file, no watcher)
- Reads file via `fs` seam, parses, maps, upserts via store, archives
  via `fs.rename` into `YYYY-MM/`. Returns stats.
- RED tests cover: happy path, already-imported (stats=skipped),
  malformed file (throws structured error, file NOT archived),
  archive directory auto-created, archive collision strategy
  (suffix with `-1`, `-2`).

### Slice 4 — `FileWatcher` seam + chokidar adapter + loop
- Interface, fake, real adapter. `startWhatsAppWatcher` de-duplicates
  events (chokidar fires multiple `add` events during file copy) by
  waiting for `stable` (size unchanged across two ticks via injected
  clock) before calling `importWhatsAppFile`.
- RED tests use fake watcher + fake clock.

### Slice 5 — CLI `--import-whatsapp [--watch]`
- One-shot: scan downloads dir for `WhatsApp Chat*.txt`, import each.
- Watch: start watcher until SIGINT.
- RED tests via existing `runCli` harness.

### Slice 6 — `src/index.ts` wiring + config knobs
- New config fields, watcher started when `WALDO_WHATSAPP_WATCH=true`.
- Default off — safe for NAS.

### Slice 7 — MCP projection sanity (no code unless broken)
- Add e2e-style tests (or extend existing) that insert a whatsapp row
  and verify `get_recent_activity`, `search`, `get_thread` return it
  with the expected projection. Fix projections only if a test fails.

### Slice 8 — Docs + PROGRESS.md checkboxes + /deploy-nas impact note
- Update user-guide, changelog, tick PROGRESS.md rows, and note
  whether the NAS deploy recipe needs any change (likely none —
  the watcher is off by default on the NAS).

### (Manual, not coded) Weekend 6 tail
- Tailscale on Android
- Claude mobile connector → remote MCP endpoint
- First *"wtf is going on?"* from the train 🚄

These stay unchecked in PROGRESS.md until the operator does them.

## RED test list (slice 1 only — subsequent slices list their own
at their own FRAME step)

1. `parseWhatsAppExport` — single line message → one parsed row with
   exact `sentAtIso`, `sender`, `body`, `chat="unknown"` when no
   chat-name hint is passed.
2. Multi-line message: second line has no timestamp → appended to
   previous message's `body` with `\n` separator.
3. System message (`Messages and calls are end-to-end encrypted…`) →
   `type="system"`, skipped by default.
4. `<Media omitted>` → `type="media"`, skipped by default.
5. Malformed line that looks like a date but isn't → thrown
   `WhatsAppParseError` with line number.
6. BOM + ZWSP-prefixed first line → parsed correctly.
7. Empty file → `[]`, no throw.
8. Mac locale date `[15/04/2026, 09:03:17]` → correct ISO in Europe/
   Brussels offset using injected clock/tz.
9. Chat name hint (from filename `WhatsApp Chat - Mom.txt`) flows
   through to every parsed row's `chat` field.
10. Deterministic: parsing the same text twice yields equal objects.

## Risks & open questions

- **Locale / timezone**: WhatsApp's `.txt` format varies by phone
  locale. waldo's Mac is `en-BE` with `dd/MM/yyyy, HH:mm:ss`.
  Hardcode via config knob `WALDO_WHATSAPP_LOCALE` (default
  `mac-en-be`), not auto-detected. Document in user-guide.
  *Open Q*: does waldo's phone export as 12h or 24h? Confirm before
  slice 1 RED tests.
- **Multi-line join rule**: WhatsApp allows newlines in messages.
  Rule: any line that does **not** start with `[<date>,` is a
  continuation of the previous message. This misses edge cases where
  a user literally typed `[15/04/2026,` at the start of a message —
  accepted tradeoff.
- **Chat name**: WhatsApp exports don't encode the chat name inside
  the `.txt`; it's in the filename. Parser accepts a
  `chatName` option; importer derives it from filename regex
  `WhatsApp Chat - (.+)\.txt`.
- **Attachments**: skipped; `raw_json` for whatsapp rows stores the
  raw line(s) for forensic value.
- **`upsertMessages` return shape**: does it today return an
  imported-vs-skipped count? If not, slice 3 may need a small
  contract extension (`upsertMessages` → `{inserted, updated}`) or
  the importer does a pre-check. **Decide at slice 3 FRAME.**
- **Security**: WhatsApp contents may include personal/family data.
  Same disk-encryption stance as §9 applies. No new fixtures with
  real content — tests use synthetic fixtures under `src/testing/
  fixtures/whatsapp-*.txt`.
- **NAS**: watcher is **off by default on the NAS** because exports
  land on the Mac. Slice 6 wiring makes this explicit.

## Definition of done (for the whole weekend)

- Slices 1–8 all pass `/tdd-cycle` with ≥90% coverage on touched files.
- `/security-scan` clean.
- `/docs-update` run; changelog + user-guide + PROGRESS.md updated.
- Live smoke on the Mac: drop a real (redacted) export in
  `~/Downloads/`, watcher imports it, file is archived, Claude
  Desktop's `search` finds a message from it.
- Manual Android/Tailscale tail left as unchecked PROGRESS.md items
  (operator work).

---

**Next step if approved**: start Slice 1 — post FRAME, write RED test
list, prove RED, scaffold, GREEN, refactor, cover. Stop between slices
for user review.
