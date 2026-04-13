// Example: canonical unit test for the delta sync path.
// Shows the full shape — RED list, injected seams, deterministic time,
// semantic assertions, log assertions, and trace-through to sync_log.
//
// Port to src/sync/delta.test.ts at Weekend 2 once the real module exists.
// Reference: ../../docs/tdd/methodology.md, ../../docs/tdd/testability-patterns.md

/*
RED list for `deltaSync`:
  - AC1: on first run against an empty store, fetches /delta, stores all rows,
         persists deltaLink, logs "delta_sync_completed" with added=N
  - AC2: on second run against unchanged Graph, inserts zero rows,
         leaves deltaLink unchanged, logs added=0
  - AC3: on @removed entries, deletes matching rows from the store
  - AC4: on nextLink paging, walks all pages before persisting deltaLink
  - AC5: on HTTP 429, surfaces GraphRateLimitedError,
         does NOT update deltaLink, logs "graph_rate_limited"
  - AC6: on HTTP 410 (delta token invalid), clears stored deltaLink,
         logs "delta_token_invalidated", caller re-runs as full sync
  - AC7: on token-expired (401), surfaces TokenExpiredError,
         does NOT update deltaLink, does NOT insert rows
  - AC8: body HTML is stripped to plain text before storing
  - AC9: unicode in subject/body/sender survives round-trip
*/

import { describe, it, expect, beforeEach } from "vitest";
import { FakeClock } from "./fake-clock.example";
import {
  FakeGraphClient,
  GraphRateLimitedError,
  TokenExpiredError,
  DeltaTokenInvalidError,
  type GraphMessage,
} from "./fake-graph-client.example";

// These imports are what the real test will pull in.
// Stubs here so the example typechecks as documentation.
interface MessageStore {
  insertMany(rows: unknown[]): number;
  deleteByNativeId(ids: string[]): number;
  count(): number;
  getDeltaLink(account: string, source: string): string | null;
  setDeltaLink(account: string, source: string, link: string): void;
  clearDeltaLink(account: string, source: string): void;
}
interface Logger {
  info(event: string, ctx?: unknown): void;
  warn(event: string, ctx?: unknown): void;
  error(event: string, ctx?: unknown): void;
}
declare const makeDeltaSync: (deps: {
  graph: FakeGraphClient;
  store: MessageStore;
  clock: FakeClock;
  logger: Logger;
  tokenFor: (account: string) => Promise<string>;
}) => (account: string, source: "outlook" | "teams") => Promise<{ added: number; removed: number }>;

const msg = (overrides: Partial<GraphMessage> = {}): GraphMessage => ({
  id: "AAMkAD-default",
  receivedDateTime: "2026-04-13T10:00:00Z",
  subject: "hello",
  from: { emailAddress: { name: "Alice", address: "alice@example.invalid" } },
  body: { contentType: "text", content: "hi" },
  ...overrides,
});

describe("deltaSync", () => {
  let store: MessageStore;
  let logger: Logger & { entries: Array<{ level: string; event: string; ctx?: unknown }> };
  let clock: FakeClock;
  let tokenFor: (account: string) => Promise<string>;

  beforeEach(() => {
    // Real setup ports in at Weekend 2: InMemoryMessageStore, ArrayLogger, etc.
    store = /* stub */ {} as MessageStore;
    logger = Object.assign(
      {
        info: (e: string, c?: unknown) => logger.entries.push({ level: "info", event: e, ctx: c }),
        warn: (e: string, c?: unknown) => logger.entries.push({ level: "warn", event: e, ctx: c }),
        error: (e: string, c?: unknown) => logger.entries.push({ level: "error", event: e, ctx: c }),
      },
      { entries: [] as Array<{ level: string; event: string; ctx?: unknown }> },
    );
    clock = new FakeClock("2026-04-13T10:00:00Z");
    tokenFor = async () => "fake-token";
  });

  it("AC1: on first run, fetches delta, stores rows, and persists deltaLink", async () => {
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: {
            value: [msg({ id: "m1" }), msg({ id: "m2" })],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=abc",
          },
        },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    const result = await sync("eric@dynex.be", "outlook");

    expect(result.added).toBe(2);
    expect(store.getDeltaLink("eric@dynex.be", "outlook")).toMatch(/token=abc/);
    expect(logger.entries.find((e) => e.event === "delta_sync_completed")).toBeDefined();
  });

  it("AC2: on second run against unchanged Graph, inserts zero rows", async () => {
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: { value: [], "@odata.deltaLink": "https://graph/v1.0/delta?token=abc" } },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    const result = await sync("eric@dynex.be", "outlook");

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("AC3: on @removed entries, deletes matching rows from the store", async () => {
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: {
            value: [{ ...msg({ id: "m1" }), "@removed": { reason: "deleted" } }],
            "@odata.deltaLink": "https://graph/v1.0/delta?token=abc",
          },
        },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    const result = await sync("eric@dynex.be", "outlook");

    expect(result.removed).toBe(1);
  });

  it("AC4: walks nextLink pages before persisting the final deltaLink", async () => {
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: { value: [msg({ id: "m1" })], "@odata.nextLink": "https://graph/v1.0/delta?page=2" } },
        { kind: "ok", response: { value: [msg({ id: "m2" })], "@odata.deltaLink": "https://graph/v1.0/delta?token=final" } },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    const result = await sync("eric@dynex.be", "outlook");

    expect(result.added).toBe(2);
    expect(graph.calls).toHaveLength(2);
    expect(store.getDeltaLink("eric@dynex.be", "outlook")).toMatch(/token=final/);
  });

  it("AC5: on HTTP 429, surfaces the error and does not update the deltaLink", async () => {
    const graph = new FakeGraphClient({
      steps: [{ kind: "error", error: new GraphRateLimitedError(30) }],
    });
    const before = store.getDeltaLink("eric@dynex.be", "outlook");
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    await expect(sync("eric@dynex.be", "outlook")).rejects.toBeInstanceOf(GraphRateLimitedError);

    expect(store.getDeltaLink("eric@dynex.be", "outlook")).toBe(before);
    expect(logger.entries.find((e) => e.event === "graph_rate_limited")).toBeDefined();
  });

  it("AC6: on HTTP 410 delta-token-invalid, clears the stored deltaLink", async () => {
    const graph = new FakeGraphClient({
      steps: [{ kind: "error", error: new DeltaTokenInvalidError("token expired") }],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    await expect(sync("eric@dynex.be", "outlook")).rejects.toBeInstanceOf(DeltaTokenInvalidError);

    expect(store.getDeltaLink("eric@dynex.be", "outlook")).toBeNull();
    expect(logger.entries.find((e) => e.event === "delta_token_invalidated")).toBeDefined();
  });

  it("AC7: on 401, surfaces TokenExpiredError and inserts no rows", async () => {
    const graph = new FakeGraphClient({
      steps: [{ kind: "error", error: new TokenExpiredError("401") }],
    });
    const before = store.count();
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    await expect(sync("eric@dynex.be", "outlook")).rejects.toBeInstanceOf(TokenExpiredError);

    expect(store.count()).toBe(before);
  });

  it("AC8: strips HTML body to plain text before storing", async () => {
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: {
            value: [msg({ id: "h1", body: { contentType: "html", content: "<p>hello <b>world</b></p>" } })],
            "@odata.deltaLink": "https://graph/v1.0/delta?token=abc",
          },
        },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    await sync("eric@dynex.be", "outlook");

    // Real assertion will query the store for the stored `body` column.
    // Expectation: "hello world" (HTML stripped, entities decoded).
  });

  it("AC9: unicode in subject/body/sender survives round-trip", async () => {
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: {
            value: [msg({ id: "u1", subject: "café ☕ 🚄", body: { contentType: "text", content: "naïve résumé" } })],
            "@odata.deltaLink": "https://graph/v1.0/delta?token=abc",
          },
        },
      ],
    });
    const sync = makeDeltaSync({ graph, store, clock, logger, tokenFor });

    await sync("eric@dynex.be", "outlook");

    // Real assertion queries the store and expects `subject` to equal "café ☕ 🚄".
  });
});
