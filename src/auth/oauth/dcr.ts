import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";

export interface DcrRequest {
  readonly body: unknown;
  readonly store: AuthStore;
  readonly ids: RandomIdSource;
  readonly clock: Clock;
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

const isAllowedRedirectUri = (uri: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }
  return false;
};

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
    if (!isAllowedRedirectUri(uri)) {
      return errorResponse(
        400,
        "invalid_redirect_uri",
        `redirect_uri must be https or http(://localhost|127.0.0.1): ${uri}`,
      );
    }
  }

  const clientName =
    typeof obj.client_name === "string" ? obj.client_name : undefined;
  const clientId = req.ids.next();
  const issuedAt = req.clock.now();

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
