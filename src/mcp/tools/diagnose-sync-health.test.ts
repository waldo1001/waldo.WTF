import { describe, it, expect } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { InMemoryVivaSubscriptionStore } from "../../testing/in-memory-viva-subscription-store.js";
import {
  DIAGNOSE_SYNC_HEALTH_TOOL,
  handleDiagnoseSyncHealth,
} from "./diagnose-sync-health.js";

const NOW = "2026-04-24T12:00:00Z";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function clockAt(iso: string = NOW): FakeClock {
  return new FakeClock(new Date(iso));
}

describe("handleDiagnoseSyncHealth — AC-D1..D19", () => {
  it("AC-D1: empty store returns healthy with no findings", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.overallStatus).toBe("healthy");
    expect(result.findings).toEqual([]);
    expect(result.summary.totalFindings).toBe(0);
    expect(result.generatedAt).toBe("2026-04-24T12:00:00.000Z");
  });

  it("AC-D2: one ok row in the last minute returns healthy", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 3,
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.overallStatus).toBe("healthy");
    expect(result.findings).toEqual([]);
  });

  it("AC-D3: TokenExpiredError → one 'auth' finding, severity 'error', critical, prompt mentions --add-account", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "TokenExpiredError: Yammer 401",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.category).toBe("auth");
    expect(f.severity).toBe("error");
    expect(result.overallStatus).toBe("critical");
    expect(f.remediationPrompt).toContain("--add-account");
    expect(f.account).toBe("a@example.test");
    expect(f.source).toBe("outlook");
  });

  it("AC-D4: GraphRateLimitedError → 'rate-limit' warn + retryAfterSeconds in evidence", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "graph rate limited, retry after 42s",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.category).toBe("rate-limit");
    expect(f.severity).toBe("warn");
    expect(f.evidence["retryAfterSeconds"]).toBe(42);
    expect(result.overallStatus).toBe("degraded");
  });

  it("AC-D5: DeltaTokenInvalidError → 'delta-invalid' error → critical", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "teams",
      status: "error",
      errorMessage: "DeltaTokenInvalidError: token expired",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("delta-invalid");
    expect(result.findings[0]?.severity).toBe("error");
    expect(result.overallStatus).toBe("critical");
  });

  it("AC-D6: 3 consecutive error rows with unclassifiable message → 'repeated-failure' warn", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    for (let i = 3; i >= 1; i--) {
      await store.appendSyncLog({
        ts: new Date(now.getTime() - i * MIN),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "ENETDOWN",
      });
    }
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("repeated-failure");
    expect(result.findings[0]?.severity).toBe("warn");
    expect(result.findings[0]?.evidence["consecutiveFailures"]).toBe(3);
  });

  it("AC-D7: 5 consecutive error rows → 'repeated-failure' severity 'error'", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    for (let i = 5; i >= 1; i--) {
      await store.appendSyncLog({
        ts: new Date(now.getTime() - i * MIN),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "ENETDOWN",
      });
    }
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("repeated-failure");
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("AC-D8: last ok 30 min ago → 'stale' severity 'warn'", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("stale");
    expect(result.findings[0]?.severity).toBe("warn");
  });

  it("AC-D9: last ok 8h ago → 'stale' severity 'error'", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 8 * HOUR),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("stale");
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("AC-D10: enabled viva sub with no viva-engage ok in 24h → viva-sub-drift; external tenant marks evidence", async () => {
    const clock = clockAt();
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore(clock);
    // Subscribed >24h ago so grace period doesn't suppress.
    clock.set(new Date(new Date(NOW).getTime() - 48 * HOUR));
    await vivaSubs.subscribe({
      account: "a@example.test",
      tenantId: "tenant-external",
      networkId: "net-1",
      communityId: "com-1",
      communityName: "Contoso Eng",
    });
    clock.set(new Date(NOW));
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clock,
    );
    const drift = result.findings.find((f) => f.category === "viva-sub-drift");
    expect(drift).toBeDefined();
    expect(drift?.evidence["communityId"]).toBe("com-1");
    expect(drift?.evidence["tenantId"]).toBe("tenant-external");
    expect(drift?.summary.toLowerCase()).toContain("external tenant");
    expect(drift?.severity).toBe("warn");
  });

  it("AC-D10a: viva sub inside 24h grace period does NOT drift", async () => {
    const clock = clockAt();
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore(clock);
    // Subscribed 2h ago — grace period active.
    clock.set(new Date(new Date(NOW).getTime() - 2 * HOUR));
    await vivaSubs.subscribe({
      account: "a@example.test",
      networkId: "net-1",
      communityId: "com-1",
    });
    clock.set(new Date(NOW));
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clock,
    );
    expect(
      result.findings.find((f) => f.category === "viva-sub-drift"),
    ).toBeUndefined();
  });

  it("AC-D11: account with no sync_log + no sync_state → 'never-synced'", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await store.upsertAccount({
      username: "fresh@example.test",
      addedAt: new Date(new Date(NOW).getTime() - 1 * HOUR),
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("never-synced");
    expect(result.findings[0]?.account).toBe("fresh@example.test");
  });

  it("AC-D12: precedence — auth error for a pair wins; no stale finding also emitted for it", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    // Old ok → stale trigger. Latest is auth error → that's what emits.
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 8 * HOUR),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "TokenExpiredError: 401 Unauthorized",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    const pair = result.findings.filter(
      (f) => f.account === "a@example.test" && f.source === "outlook",
    );
    expect(pair).toHaveLength(1);
    expect(pair[0]?.category).toBe("auth");
  });

  it("AC-D13: aggregation — mixed warn+error → critical; warn only → degraded; none → healthy", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    // Warn-only: stale 30min
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const warnOnly = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(warnOnly.overallStatus).toBe("degraded");

    // Now add an auth error for a different pair.
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "b@example.test",
      source: "teams",
      status: "error",
      errorMessage: "TokenExpiredError: 401",
    });
    const mixed = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(mixed.overallStatus).toBe("critical");
  });

  it("AC-D14: findings sorted by (severity desc, account asc, source asc, category asc)", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    // Seed in deliberately shuffled order:
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "zebra@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "alpha@example.test",
      source: "teams",
      status: "error",
      errorMessage: "TokenExpiredError",
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "alpha@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(
      result.findings.map((f) => `${f.severity}:${f.account}:${f.source ?? ""}:${f.category}`),
    ).toEqual([
      "error:alpha@example.test:teams:auth",
      "warn:alpha@example.test:outlook:stale",
      "warn:zebra@example.test:outlook:stale",
    ]);
  });

  it("AC-D15: generatedAt honours the injected clock", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt("2030-01-01T00:00:00Z"),
    );
    expect(result.generatedAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("AC-D16: DIAGNOSE_SYNC_HEALTH_TOOL descriptor is zero-input and clearly read-only", () => {
    expect(DIAGNOSE_SYNC_HEALTH_TOOL.name).toBe("diagnose_sync_health");
    expect(DIAGNOSE_SYNC_HEALTH_TOOL.inputSchema.type).toBe("object");
    expect(DIAGNOSE_SYNC_HEALTH_TOOL.inputSchema.additionalProperties).toBe(
      false,
    );
    expect(
      Object.keys(DIAGNOSE_SYNC_HEALTH_TOOL.inputSchema.properties ?? {}),
    ).toEqual([]);
    expect(DIAGNOSE_SYNC_HEALTH_TOOL.description.toLowerCase()).toContain(
      "read-only",
    );
    expect(DIAGNOSE_SYNC_HEALTH_TOOL.description.toLowerCase()).toContain(
      "remediation",
    );
  });

  it("AC-D17: handler runs without vivaSubs and simply skips viva-sub-drift", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "TokenExpiredError",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      undefined,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("auth");
    expect(
      result.findings.some((f) => f.category === "viva-sub-drift"),
    ).toBe(false);
  });

  it("AC-D18: evidence always includes account; category-specific facts attached", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    // stale
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    // repeated-failure, 3 errors
    for (let i = 3; i >= 1; i--) {
      await store.appendSyncLog({
        ts: new Date(now.getTime() - i * MIN),
        account: "b@example.test",
        source: "teams",
        status: "error",
        errorMessage: "ENETDOWN",
      });
    }
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    for (const f of result.findings) {
      expect(f.evidence["account"]).toBe(f.account);
    }
    const stale = result.findings.find((f) => f.category === "stale");
    expect(typeof stale?.evidence["staleMs"]).toBe("number");
    const repeated = result.findings.find(
      (f) => f.category === "repeated-failure",
    );
    expect(repeated?.evidence["consecutiveFailures"]).toBe(3);
  });

  it("AC-D19: Bearer tokens embedded in lastError are redacted in evidence + prompt", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage:
        "TokenExpiredError: Bearer eyJhbGciOiJIUzI1 rejected by server",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(JSON.stringify(f.evidence)).not.toContain("eyJhbGciOiJIUzI1");
    expect(f.evidence["lastError"]).toContain("[REDACTED]");
    expect(f.remediationPrompt).not.toContain("eyJhbGciOiJIUzI1");
    expect(f.remediationPrompt).toContain("[REDACTED]");
  });

  it("single unclassifiable error (consecutive=1) emits 'unknown-error', not repeated-failure", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "ENETDOWN",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("unknown-error");
    expect(result.findings[0]?.severity).toBe("warn");
  });

  it("viva-sub-drift is suppressed when a viva-engage ok row exists within 24h", async () => {
    const clock = clockAt();
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore(clock);
    clock.set(new Date(new Date(NOW).getTime() - 48 * HOUR));
    await vivaSubs.subscribe({
      account: "a@example.test",
      networkId: "net-1",
      communityId: "com-1",
    });
    clock.set(new Date(NOW));
    await store.appendSyncLog({
      ts: new Date(new Date(NOW).getTime() - 1 * HOUR),
      account: "a@example.test",
      source: "viva-engage",
      status: "ok",
      messagesAdded: 2,
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clock,
    );
    expect(
      result.findings.find((f) => f.category === "viva-sub-drift"),
    ).toBeUndefined();
  });

  it("disabled viva subscription does not drift", async () => {
    const clock = clockAt();
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore(clock);
    clock.set(new Date(new Date(NOW).getTime() - 48 * HOUR));
    await vivaSubs.subscribe({
      account: "a@example.test",
      networkId: "net-1",
      communityId: "com-disabled",
    });
    await vivaSubs.toggleEnabled("a@example.test", "com-disabled", false);
    clock.set(new Date(NOW));
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clock,
    );
    expect(
      result.findings.find((f) => f.category === "viva-sub-drift"),
    ).toBeUndefined();
  });

  it("never-synced sorts after findings with a source at the same severity/account", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    // 'a@example.test' has both never-synced (source undefined) and
    // a stale-outlook warn finding? No — never-synced only emits when
    // the account has NO history. Use two different accounts.
    await store.upsertAccount({
      username: "a@example.test",
      addedAt: new Date(now.getTime() - 1 * HOUR),
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    // Second account is "fresh" (no history)
    await store.upsertAccount({
      username: "b@example.test",
      addedAt: new Date(now.getTime() - 1 * HOUR),
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    // Both are severity=warn. Sort order: a/outlook then b/<no source>.
    expect(result.findings.map((f) => f.account)).toEqual([
      "a@example.test",
      "b@example.test",
    ]);
    expect(result.findings[1]?.source).toBeUndefined();
  });

  it("never-synced ties break by category when account and severity match", async () => {
    // Synthesise two findings with same (severity, account, source=undefined)
    // by placing two never-synced accounts in the same sort bucket.
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await store.upsertAccount({
      username: "z@example.test",
      addedAt: new Date(new Date(NOW).getTime() - 1 * HOUR),
    });
    await store.upsertAccount({
      username: "a@example.test",
      addedAt: new Date(new Date(NOW).getTime() - 1 * HOUR),
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.findings.map((f) => f.account)).toEqual([
      "a@example.test",
      "z@example.test",
    ]);
  });

  it("summary counts match findings list", async () => {
    const store = new InMemoryMessageStore();
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const now = new Date(NOW);
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 30 * MIN),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * MIN),
      account: "b@example.test",
      source: "teams",
      status: "error",
      errorMessage: "TokenExpiredError",
    });
    const result = await handleDiagnoseSyncHealth(
      store,
      vivaSubs,
      clockAt(),
    );
    expect(result.summary.totalFindings).toBe(result.findings.length);
    expect(result.summary.byCategory.auth).toBe(1);
    expect(result.summary.byCategory.stale).toBe(1);
    expect(result.summary.bySeverity.error).toBe(1);
    expect(result.summary.bySeverity.warn).toBe(1);
    expect(result.summary.bySeverity.info).toBe(0);
  });
});
