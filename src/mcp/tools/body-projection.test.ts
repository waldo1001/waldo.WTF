import { describe, expect, it } from "vitest";
import type { Message } from "../../store/types.js";
import {
  MAX_BODY_CHARS,
  TRUNCATION_SENTINEL,
  projectBody,
} from "./body-projection.js";

const mk = (overrides: Partial<Message> = {}): Message => ({
  id: "teams:a@example.test:1",
  source: "teams",
  account: "a@example.test",
  nativeId: "native-1",
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
  ...overrides,
});

describe("projectBody", () => {
  it("returns nothing when the message has no body", () => {
    const result = projectBody(mk({ body: undefined }), 400_000);
    expect(result).toEqual({ consumed: 0 });
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("bodyTruncated");
  });

  it("returns the full body when it fits within cap and budget", () => {
    const body = "hello world";
    const result = projectBody(mk({ body }), 400_000);
    expect(result.body).toBe(body);
    expect(result.consumed).toBe(body.length);
    expect(result).not.toHaveProperty("bodyTruncated");
  });

  it("truncates a body longer than MAX_BODY_CHARS and marks bodyTruncated", () => {
    const body = "x".repeat(MAX_BODY_CHARS + 500);
    const result = projectBody(mk({ body }), 400_000);
    expect(result.bodyTruncated).toBe(true);
    expect(result.consumed).toBe(MAX_BODY_CHARS);
    expect(result.body).toBeDefined();
    expect(result.body!.endsWith(TRUNCATION_SENTINEL)).toBe(true);
    expect(result.body!.length).toBe(MAX_BODY_CHARS + TRUNCATION_SENTINEL.length);
    expect(result.body!.startsWith("x".repeat(100))).toBe(true);
  });

  it("returns nothing when the budget is already exhausted", () => {
    const result = projectBody(mk({ body: "hello" }), 0);
    expect(result).toEqual({ consumed: 0 });
    expect(result).not.toHaveProperty("body");
  });

  it("returns nothing when the budget cannot fit the full body", () => {
    const body = "a".repeat(1000);
    const result = projectBody(mk({ body }), 500);
    expect(result).toEqual({ consumed: 0 });
    expect(result).not.toHaveProperty("body");
  });
});
