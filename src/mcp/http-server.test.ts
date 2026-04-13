import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer } from "./http-server.js";

const BEARER = "bearer-xyz";

describe("createMcpHttpServer", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createMcpHttpServer({ bearerToken: BEARER });
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

  it("GET /anything without Authorization returns 401 unauthorized", async () => {
    const res = await fetch(`${baseUrl}/anything`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /anything with malformed Authorization returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with empty bearer token returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with wrong bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with correct bearer returns 404 not_found", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("shorter-than-expected bearer returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer short" },
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
