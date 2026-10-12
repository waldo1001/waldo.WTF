import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.js";

describe("clientIp", () => {
  it("uses the left-most X-Forwarded-For entry when the peer is loopback (Tailscale Serve/Funnel)", () => {
    expect(clientIp("127.0.0.1", "203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp("::1", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientIp("::ffff:127.0.0.1", " 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For from a non-loopback peer (spoofing)", () => {
    expect(clientIp("100.64.0.5", "1.2.3.4")).toBe("100.64.0.5");
  });

  it("returns 'unknown' for a loopback peer without a usable X-Forwarded-For", () => {
    expect(clientIp("127.0.0.1", undefined)).toBe("unknown");
    expect(clientIp("127.0.0.1", "")).toBe("unknown");
    expect(clientIp("127.0.0.1", " , 1.2.3.4")).toBe("unknown");
  });

  it("takes the first header when X-Forwarded-For is repeated", () => {
    expect(clientIp("127.0.0.1", ["198.51.100.1", "1.2.3.4"])).toBe("198.51.100.1");
  });

  it("returns 'unknown' when the socket has no remote address", () => {
    expect(clientIp(undefined, "1.2.3.4")).toBe("unknown");
  });
});
