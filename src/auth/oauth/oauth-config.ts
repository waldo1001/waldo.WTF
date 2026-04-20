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

export function loadOAuthConfig(env: Env): OAuthConfig {
  if (!present(env.WALDO_PUBLIC_URL)) {
    throw new OAuthConfigError("WALDO_PUBLIC_URL is required");
  }
  const publicUrl = parsePublicUrl(env.WALDO_PUBLIC_URL);
  const disableStaticBearer = env.WALDO_DISABLE_STATIC_BEARER === "true";
  const adminPassword = present(env.WALDO_ADMIN_PASSWORD)
    ? env.WALDO_ADMIN_PASSWORD
    : undefined;

  return {
    publicUrl,
    disableStaticBearer,
    ...(adminPassword !== undefined ? { adminPassword } : {}),
  };
}
