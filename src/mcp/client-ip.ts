const LOOPBACK_PEERS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * The client IP used as a rate-limit key. Behind Tailscale Serve/Funnel every
 * request arrives from loopback, so the left-most X-Forwarded-For entry is the
 * only discriminator — trusted ONLY when the socket peer is loopback (a direct
 * tailnet caller could otherwise forge it). Without a usable value, all such
 * callers share the "unknown" bucket (still bounded by the global limit).
 */
export function clientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
): string {
  if (remoteAddress === undefined) return UNKNOWN_CLIENT_IP;
  if (!LOOPBACK_PEERS.has(remoteAddress)) return remoteAddress;
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = (header ?? "").split(",")[0]?.trim() ?? "";
  return first === "" ? UNKNOWN_CLIENT_IP : first;
}
