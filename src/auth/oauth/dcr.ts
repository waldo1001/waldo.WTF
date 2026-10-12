import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";
import { isRedirectAllowed } from "./redirect-allowlist.js";

const MAX_CLIENT_NAME_LENGTH = 64;
// A registration that never got as far as a code or token within a day was
// abandoned (or junk); it can be reclaimed to make room under the cap.
const UNUSED_CLIENT_GRACE_MS = 24 * 3600 * 1000;

export interface DcrRequest {
  readonly body: unknown;
  readonly store: AuthStore;
  readonly ids: RandomIdSource;
  readonly clock: Clock;
  readonly redirectAllowlist: readonly string[];
  readonly maxClients: number;
}

// RFC 7591 + 8414 client metadata projection. Only the fields slice 1 cares
// about; expand as later slices add scopes / token endpoint auth methods.
export interface ClientInformationResponse {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly response_types: readonly ["code"];
  readonly client_name?: string;
}

export interface ErrorResponse {
  readonly error: string;
  readonly error_description?: string;
}

export type DcrResponseBody = ClientInformationResponse | ErrorResponse;

export interface DcrResponse {
  readonly status: number;
  // discriminated by `error` key, exhaustive caller-side
  readonly body: any;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const errorResponse = (
  status: number,
  error: string,
  description: string,
): DcrResponse => ({
  status,
  body: { error, error_description: description },
});

export async function handleDynamicClientRegistration(
  req: DcrRequest,
): Promise<DcrResponse> {
  const body = req.body;
  if (typeof body !== "object" || body === null) {
    return errorResponse(
      400,
      "invalid_client_metadata",
      "request body must be a JSON object",
    );
  }
  const obj = body as Record<string, unknown>;
  const redirectUris = obj.redirect_uris;
  if (!isStringArray(redirectUris)) {
    return errorResponse(
      400,
      "invalid_client_metadata",
      "redirect_uris must be an array of strings",
    );
  }
  if (redirectUris.length === 0) {
    return errorResponse(
      400,
      "invalid_client_metadata",
      "redirect_uris must contain at least one URI",
    );
  }
  for (const uri of redirectUris) {
    if (!isRedirectAllowed(uri, req.redirectAllowlist)) {
      return errorResponse(
        400,
        "invalid_redirect_uri",
        "redirect_uri is not on this server's allowlist (WALDO_OAUTH_REDIRECT_ALLOWLIST)",
      );
    }
  }

  const clientName =
    typeof obj.client_name === "string" ? obj.client_name : undefined;
  if (clientName !== undefined && clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return errorResponse(
      400,
      "invalid_client_metadata",
      `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`,
    );
  }
  const issuedAt = req.clock.now();
  await req.store.pruneUnusedClients(
    new Date(issuedAt.getTime() - UNUSED_CLIENT_GRACE_MS),
  );
  if ((await req.store.countClients()) >= req.maxClients) {
    return errorResponse(
      503,
      "temporarily_unavailable",
      "client registration limit reached; revoke unused clients",
    );
  }
  const clientId = req.ids.next();

  await req.store.registerClient({
    clientId,
    redirectUris,
    createdAt: issuedAt,
    ...(clientName !== undefined ? { clientName } : {}),
  });

  const response: ClientInformationResponse = {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(clientName !== undefined ? { client_name: clientName } : {}),
  };
  return { status: 201, body: response };
}
