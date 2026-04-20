import { describe, expect, it } from "vitest";
import { handleDynamicClientRegistration } from "./dcr.js";
import { InMemoryAuthStore } from "../../testing/in-memory-auth-store.js";
import type { RandomIdSource } from "./ids.js";
import { FakeClock } from "../../testing/fake-clock.js";

const fixedIds = (id: string): RandomIdSource => ({ next: () => id });

describe("handleDynamicClientRegistration", () => {
  it("happy path: returns 201 + client_id + echoes redirect_uris", async () => {
    const store = new InMemoryAuthStore();
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const ids = fixedIds("a".repeat(64));

    const res = await handleDynamicClientRegistration({
      body: {
        redirect_uris: ["https://claude.ai/cb"],
        client_name: "Claude.ai connector",
      },
      store,
      ids,
      clock,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_id: "a".repeat(64),
      redirect_uris: ["https://claude.ai/cb"],
      client_name: "Claude.ai connector",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(res.body.client_id_issued_at).toBe(
      Math.floor(new Date("2026-04-20T10:00:00Z").getTime() / 1000),
    );
    expect(await store.getClient("a".repeat(64))).toMatchObject({
      clientId: "a".repeat(64),
      clientName: "Claude.ai connector",
      redirectUris: ["https://claude.ai/cb"],
    });
  });

  it("persists client_name when present, leaves undefined when absent", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("b".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    await handleDynamicClientRegistration({
      body: { redirect_uris: ["https://claude.ai/cb"] },
      store,
      ids,
      clock,
    });
    const stored = await store.getClient("b".repeat(64));
    expect(stored?.clientName).toBeUndefined();
  });

  it("rejects body without redirect_uris with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("c".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: {},
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_client_metadata",
      error_description: expect.stringContaining("redirect_uris"),
    });
    expect(await store.listClients()).toEqual([]);
  });

  it("rejects empty redirect_uris array", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("d".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [] },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a non-https / non-localhost redirect_uri", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("e".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["http://evil.example/cb"] },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("accepts http://localhost and http://127.0.0.1 redirect_uris", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("f".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: {
        redirect_uris: [
          "http://localhost:1234/cb",
          "http://127.0.0.1:5678/cb",
        ],
      },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(201);
  });

  it("rejects a malformed redirect_uri string", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("g".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["not a url"] },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-http(s) protocol redirect_uri (e.g. ftp://)", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("p".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["ftp://files.example/cb"] },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects body=null with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("n".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: null,
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a string body with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("s".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: "not an object",
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects redirect_uris that is not an array", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("h".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: "https://claude.ai/cb" },
      store,
      ids,
      clock,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });
});
