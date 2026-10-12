// Where an authorization code may be sent. The server is internet-reachable
// (Tailscale Funnel), so an open DCR redirect would let anyone mint a client
// that receives codes on their own host — consent phishing. Remote callbacks
// must match an allowlist entry exactly; loopback is always allowed because
// native clients (Claude Desktop / Claude Code) listen on a random local port.
export const DEFAULT_REDIRECT_ALLOWLIST: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const parse = (uri: string): URL | undefined => {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
};

export function isRedirectAllowed(
  uri: string,
  allowlist: readonly string[],
): boolean {
  const parsed = parse(uri);
  if (!parsed) return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  // Raw check: URL drops an empty trailing "#" from .hash.
  if (uri.includes("#")) return false;
  if (parsed.protocol === "http:") {
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }
  if (parsed.protocol === "https:") {
    return allowlist.includes(uri);
  }
  return false;
}
