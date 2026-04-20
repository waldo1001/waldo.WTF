# Weekend 2 — Slice 2: Filesystem seam + in-memory fake

**Status:** DRAFT — awaiting user approval before FRAME/RED.

## Task

Land the `FileSystem` seam (`src/fs.ts`) and its in-memory test double
(`src/testing/in-memory-file-system.ts`), proven by failing-then-passing
contract tests. No consumer yet — the seam is introduced ahead of the
first module that needs it (token cache, delta-state persistence).

## Why this slice next

- PROGRESS.md Weekend 2: "Port example fakes from testing/examples/ into
  `src/testing/` (clock done; fs/graph pending)".
- Slice 1's out-of-scope list names this as the next candidate: "Slice 2
  candidate: `Fs` seam + `FakeFs` (needed for token-cache, delta-state
  persistence)".
- Every persistence-touching module downstream (MSAL token cache,
  delta-state JSON, WhatsApp `.txt` watcher, archive moves) injects this
  seam, so landing it now keeps those future slices narrow.
- Low risk: no native deps, no network, no secrets. The only external
  dependency that will eventually matter (`chokidar` for `watch()`) is
  deferred to the real impl slice.

## Scope boundary

**IN this slice:**
- `src/fs.ts` — `FileSystem` interface matching
  [docs/tdd/testability-patterns.md §3.4](../tdd/testability-patterns.md)
  exactly:
  - `readFile(path): Promise<Buffer>`
  - `writeFile(path, data: Buffer | string, mode?: number): Promise<void>`
  - `rename(from, to): Promise<void>`
  - `watch(dir, glob, onEvent): () => void`
  - `listDir(path): Promise<string[]>` (sorted)
- `src/testing/in-memory-file-system.ts` — `InMemoryFileSystem`
  implementing that interface, backed by `Map<string, Buffer>`. Exposes
  a `trigger(path)` method for driving `watch()` in tests.
- `src/testing/in-memory-file-system.test.ts` — contract tests (RED list
  below).
- `npm test` green, `npm run typecheck` clean, coverage ≥90% on touched
  files.

**OUT of scope (deferred):**
- The real `FileSystem` impl (`src/support/fs-node.ts`) wrapping
  `node:fs/promises` + `chokidar`. Lands with the first consumer that
  needs a real one (likely the token-cache slice).
- Any business-logic module that consumes `FileSystem` (token cache,
  delta-state, config loader).
- Fake graph client (separate slice — scripted GraphClient fake has its
  own shape and deserves its own plan).
- `.gitignore` / tooling changes.
- Path normalization helpers, glob parsing beyond what the minimal tests
  require.

## Files to create / touch

| Path | New? | Purpose |
|---|---|---|
| `src/fs.ts` | new | `FileSystem` interface |
| `src/testing/in-memory-file-system.ts` | new | in-memory fake |
| `src/testing/in-memory-file-system.test.ts` | new | RED contract tests |

## Seams involved

- `filesystem` (introduced this slice)
- none other

## RED test list

```
- AC1: writeFile then readFile round-trips bytes
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "writeFile followed by readFile returns the same bytes"
  - seams touched: filesystem
  - edge cases: string payload is stored as UTF-8 Buffer and returned as Buffer

- AC2: readFile on a missing path rejects with an ENOENT-shaped error
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "readFile rejects when the path does not exist"
  - seams touched: filesystem
  - edge cases: error carries `code: "ENOENT"` so consumers can branch on it
    without string-matching messages

- AC3: writeFile overwrites an existing path
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "writeFile replaces the contents at an existing path"
  - seams touched: filesystem
  - edge cases: second write fully replaces, does not append

- AC4: rename moves bytes from source to destination and removes source
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "rename moves bytes and removes the source path"
  - seams touched: filesystem
  - edge cases: rename of a missing source rejects with ENOENT

- AC5: listDir returns immediate children of a directory, sorted
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "listDir returns sorted immediate children"
  - seams touched: filesystem
  - edge cases: files in nested subdirs are NOT returned; empty dir returns []

- AC6: watch() delivers events when trigger(path) is called for a matching file
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "watch invokes onEvent when trigger matches the glob"
  - seams touched: filesystem
  - edge cases: non-matching paths are ignored; the returned unsubscribe
    function stops further deliveries

- AC7: watch() glob matches the WhatsApp case "WhatsApp Chat*.txt"
  - test file: src/testing/in-memory-file-system.test.ts
  - test name: "watch glob matches WhatsApp Chat*.txt but not other .txt files"
  - seams touched: filesystem
  - edge cases: this is the motivating real-world pattern from the brief;
    keep the glob engine minimal but correct for `*` wildcards
```

Seven ACs. Each RED → GREEN individually, per the skill.

## Open questions / assumptions

1. **Assumption:** Interface matches §3.4 verbatim — no additions (`stat`,
   `unlink`, `mkdir`) until a real test demands them. → **Confirm or
   override.**
2. **Assumption:** The `mode?: number` param on `writeFile` is accepted
   and stored but not asserted on in this slice (no test reads it back).
   Real impl will honor it. → **Confirm.**
3. **Assumption:** Glob support in the fake is limited to a single `*`
   wildcard inside the filename (enough for `"WhatsApp Chat*.txt"`). No
   `**`, no character classes. Real impl (chokidar) will do the heavy
   lifting later. → **Confirm or override** (alternative: pull in
   `micromatch` now).
4. **Assumption:** `watch()` only fires via explicit `trigger(path)`
   calls — it does NOT auto-fire on `writeFile`. This keeps tests fully
   deterministic and matches the example-file philosophy for the
   GraphClient fake (scripted, not reactive). → **Confirm or override**
   (alternative: auto-fire on writeFile inside the watched dir).
5. **Assumption:** Path semantics are POSIX-style string keys (forward
   slashes). No normalization of `..`, no case-insensitive matching.
   Tests will use literal paths like `"/data/token-cache.json"`. →
   **Confirm.**
6. **Assumption:** `listDir` treats "immediate children" as paths whose
   prefix is `dir + "/"` and whose remainder contains no further `/`.
   Directories themselves are implicit (there is no `mkdir`). →
   **Confirm.**
7. **Assumption:** ENOENT errors are plain `Error` instances with a
   `.code = "ENOENT"` property, matching Node's convention so consumers
   can `if (err.code === "ENOENT")` against both real and fake without
   branching. → **Confirm.**
8. **Question:** Do you want the fake exported from a barrel
   (`src/testing/index.ts`) now, or continue with direct file imports
   until there are enough doubles to justify one?

## Risks

- **Scope creep into a mini-fs.** Temptation to add `mkdir`, `stat`,
  `unlink`, recursive listDir, etc. Mitigation: stick to the seven ACs,
  add new methods only when a consumer test fails for lack of one.
- **Glob engine rabbit hole.** A full glob matcher is a project of its
  own. Mitigation: hand-rolled `*`-to-regex for a single filename
  segment, documented inline as "fake-only, real impl uses chokidar".
- **Buffer vs string ergonomics.** `writeFile` takes `Buffer | string`
  but `readFile` always returns `Buffer`. Consumers that want a string
  must `.toString("utf8")`. Mitigation: one AC pins the behavior so it
  can't drift.
- **Watch determinism.** If a future test assumes `writeFile` auto-fires
  `watch`, it'll be confused. Mitigation: docstring on the interface +
  fake explains "the fake is trigger-driven; the real impl is
  event-driven".

## Out-of-scope follow-ups (track for later slices)

- Slice 3 candidate: port `FakeGraphClient` from
  [testing/examples/fake-graph-client.example.ts](../../testing/examples/fake-graph-client.example.ts)
  into `src/testing/fake-graph-client.ts` with contract tests.
- Slice 4 candidate: real `FileSystem` impl in `src/support/fs-node.ts`
  wrapping `node:fs/promises` + `chokidar`, landed with its first
  consumer.
- Slice 5 candidate: `Logger` seam + silent fake.
- Slice 6+: token cache, delta-state persistence, SQLite store, sync
  loop, MCP skeleton.

## Definition of done for this slice

- [ ] Plan file approved by user.
- [ ] FRAME posted in chat (≤150 words).
- [ ] `npm test` reports 4 existing clock tests + 7 new fs tests, all
      passing.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] Coverage on `src/fs.ts` and `src/testing/in-memory-file-system.ts`
      ≥ 90% lines + branches.
- [ ] `/security-scan` passes.
- [ ] `/docs-update` run — changelog entry added.
- [ ] PROGRESS.md Weekend 2 updated: fs portion of the "Port example
      fakes" line ticked, fake-graph noted as remaining.
