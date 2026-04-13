import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer } from "./http-server.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";

const BEARER = "bearer-xyz";

describe("createMcpHttpServer (HTTP shell around SDK transport)", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let clock: FakeClock;

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    server = createMcpHttpServer({ bearerToken: BEARER, store, clock });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /health returns 200 { ok: true } without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET / without Authorization returns 401 unauthorized", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET / with malformed Authorization returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
  });

  it("GET / with empty bearer token returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("GET / with wrong bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("shorter-than-expected bearer returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  it("POST / without auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("server starts on listen(0) and returns a closable http.Server", () => {
    const addr = server.address() as AddressInfo;
    expect(typeof addr.port).toBe("number");
    expect(addr.port).toBeGreaterThan(0);
    expect(typeof server.close).toBe("function");
  });
});
