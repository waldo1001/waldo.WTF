import { DEFAULT_REDIRECT_ALLOWLIST } from "./redirect-allowlist.js";

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

export interface OAuthConfig {
  readonly publicUrl: string;
  readonly disableStaticBearer: boolean;
  readonly adminPassword?: string;
  readonly redirectAllowlist: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const present = (v: string | undefined): v is string =>
  v !== undefined && v !== "";

const stripTrailingSlash = (url: string): string =>
  url.endsWith("/") ? url.slice(0, -1) : url;

const parsePublicUrl = (raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OAuthConfigError(
      `WALDO_PUBLIC_URL must be a valid URL, got "${raw}"`,
    );
  }
  if (parsed.protocol === "https:") {
    return stripTrailingSlash(raw);
  }
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return stripTrailingSlash(raw);
  }
  throw new OAuthConfigError(
    `WALDO_PUBLIC_URL must be https or http://(localhost|127.0.0.1), got "${raw}"`,
  );
};

const parseRedirectAllowlist = (raw: string | undefined): readonly string[] => {
  if (!present(raw)) return DEFAULT_REDIRECT_ALLOWLIST;
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  for (const entry of entries) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(entry);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new OAuthConfigError(
        `WALDO_OAUTH_REDIRECT_ALLOWLIST entries must be https URLs without credentials, got "${entry}"`,
      );
    }
  }
  return entries;
};

export function loadOAuthConfig(env: Env): OAuthConfig {
  if (!present(env.WALDO_PUBLIC_URL)) {
    throw new OAuthConfigError("WALDO_PUBLIC_URL is required");
  }
  const publicUrl = parsePublicUrl(env.WALDO_PUBLIC_URL);
  const disableStaticBearer = env.WALDO_DISABLE_STATIC_BEARER === "true";
  const adminPassword = present(env.WALDO_ADMIN_PASSWORD)
    ? env.WALDO_ADMIN_PASSWORD
    : undefined;

  const redirectAllowlist = parseRedirectAllowlist(
    env.WALDO_OAUTH_REDIRECT_ALLOWLIST,
  );

  return {
    publicUrl,
    disableStaticBearer,
    redirectAllowlist,
    ...(adminPassword !== undefined ? { adminPassword } : {}),
  };
}
