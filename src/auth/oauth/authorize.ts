import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";
import type { PasswordHasher } from "./password.js";
import { isRedirectAllowed } from "./redirect-allowlist.js";
import type { OAuthClientRecord } from "./auth-store.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
// RFC 7636 §4.2: S256 challenge is base64url, 43..128 chars.
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export interface AuthorizeGetParams {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly response_type: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly scope?: string;
  readonly state?: string;
}

export interface AuthorizeGetRequest {
  readonly store: AuthStore;
  readonly redirectAllowlist: readonly string[];
  readonly params: AuthorizeGetParams;
}

export interface AuthorizeGetResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface AuthorizePostFormBody {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly scope?: string;
  readonly state?: string;
  readonly password: string;
}

export interface AuthorizePostRequest {
  readonly store: AuthStore;
  readonly hasher: PasswordHasher;
  readonly adminPasswordHash: string | undefined;
  readonly ids: RandomIdSource;
  readonly clock: Clock;
  readonly redirectAllowlist: readonly string[];
  readonly formBody: AuthorizePostFormBody;
}

export interface AuthorizePostResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const errorHtml = (status: number, message: string): AuthorizeGetResponse => ({
  status,
  contentType: "text/html; charset=utf-8",
  body: `<!DOCTYPE html><html><body><h1>Error ${status}</h1><p>${escHtml(message)}</p></body></html>`,
});

const escHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const redirectOrigin = (uri: string): string => {
  const u = new URL(uri);
  return `${u.protocol}//${u.host}`;
};

const consentForm = (
  client: { clientId: string; clientName?: string },
  params: AuthorizeGetParams,
  errorMsg?: string,
): string => {
  const displayName = escHtml(client.clientName ?? client.clientId);
  const err = errorMsg
    ? `<p style="color:red"><strong>${escHtml(errorMsg)}</strong></p>`
    : "";
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${escHtml(name)}" value="${escHtml(value)}">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize – waldo.WTF</title>
<style>
body{font-family:system-ui,sans-serif;max-width:480px;margin:3rem auto;padding:0 1rem}
.card{border:1px solid #ddd;border-radius:8px;padding:1.5rem}
label{display:block;margin-top:1rem;font-weight:600}
input[type=password]{width:100%;padding:.5rem;margin-top:.25rem;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;font-size:1rem}
button{margin-top:1.5rem;width:100%;padding:.75rem;background:#1d4ed8;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
button:hover{background:#1e40af}
.dest{background:#fef3c7;border:1px solid #f59e0b;padding:.75rem;border-radius:4px}
.host{font-size:1.25rem;font-family:monospace;word-break:break-all}
.scope{background:#f3f4f6;padding:.5rem;border-radius:4px;font-family:monospace}
</style>
</head>
<body>
<div class="card">
<h1>Authorize access</h1>
<p class="dest">After approval you will be sent to:<br><strong class="host">${escHtml(redirectOrigin(params.redirect_uri))}</strong></p>
<p>Only approve if that is where you started this connection. <strong>${displayName}</strong> (name is self-declared by the client) is requesting read access to your waldo.WTF message lake.</p>
<p>Scope: <span class="scope">${escHtml(params.scope ?? "mcp")}</span></p>
<p>Client ID: <code>${escHtml(client.clientId)}</code></p>
${err}
<form method="POST" action="/oauth/authorize">
${hidden("client_id", params.client_id)}
${hidden("redirect_uri", params.redirect_uri)}
${hidden("code_challenge", params.code_challenge)}
${hidden("code_challenge_method", params.code_challenge_method)}
${hidden("scope", params.scope ?? "mcp")}
${params.state !== undefined ? hidden("state", params.state) : ""}
<label for="pwd">Admin password</label>
<input type="password" id="pwd" name="password" autofocus required>
<button type="submit">Approve</button>
</form>
</div>
</body>
</html>`;
};

type ValidationResult =
  | { readonly ok: true; readonly client: OAuthClientRecord }
  | { readonly ok: false; readonly error: AuthorizeGetResponse };

// Shared by GET (render consent) and POST (mint code): the POST is a plain
// form submit anyone can craft, so it must not trust that the GET ran.
// Error messages are fixed strings — never reflect attacker-supplied input.
async function validateAuthorizeParams(
  store: AuthStore,
  params: AuthorizeGetParams,
  redirectAllowlist: readonly string[],
): Promise<ValidationResult> {
  const fail = (message: string): ValidationResult => ({
    ok: false,
    error: errorHtml(400, message),
  });
  if (params.response_type !== "code") {
    return fail("response_type must be 'code'");
  }
  if (params.code_challenge_method !== "S256") {
    return fail("code_challenge_method must be 'S256' (required by OAuth 2.1)");
  }
  if (!CODE_CHALLENGE_PATTERN.test(params.code_challenge)) {
    return fail("code_challenge is required (PKCE, 43-128 base64url characters)");
  }
  const client = await store.getClient(params.client_id);
  if (!client) {
    return fail("unknown client");
  }
  if (
    !client.redirectUris.includes(params.redirect_uri) ||
    !isRedirectAllowed(params.redirect_uri, redirectAllowlist)
  ) {
    return fail("redirect_uri is not registered for this client or not allowed");
  }
  return { ok: true, client };
}

export async function handleAuthorizeGet(
  req: AuthorizeGetRequest,
): Promise<AuthorizeGetResponse> {
  const result = await validateAuthorizeParams(
    req.store,
    req.params,
    req.redirectAllowlist,
  );
  if (!result.ok) return result.error;
  const html = consentForm(result.client, req.params);
  return { status: 200, contentType: "text/html; charset=utf-8", body: html };
}

const toPostResponse = (r: AuthorizeGetResponse): AuthorizePostResponse => ({
  status: r.status,
  headers: { "Content-Type": r.contentType },
  body: r.body,
});

export async function handleAuthorizePost(
  req: AuthorizePostRequest,
): Promise<AuthorizePostResponse> {
  if (req.adminPasswordHash === undefined) {
    return toPostResponse(
      errorHtml(503, "OAuth admin password not configured."),
    );
  }

  const { formBody, store, hasher, adminPasswordHash, ids, clock } = req;
  const params: AuthorizeGetParams = {
    client_id: formBody.client_id,
    redirect_uri: formBody.redirect_uri,
    response_type: "code",
    code_challenge: formBody.code_challenge,
    code_challenge_method: formBody.code_challenge_method,
    ...(formBody.scope !== undefined ? { scope: formBody.scope } : {}),
    ...(formBody.state !== undefined ? { state: formBody.state } : {}),
  };

  // Validate before the (deliberately slow) password check: a tampered
  // POST costs no scrypt work and can never reach saveAuthCode.
  const validation = await validateAuthorizeParams(
    store,
    params,
    req.redirectAllowlist,
  );
  if (!validation.ok) return toPostResponse(validation.error);

  const passwordOk = await hasher.verify(formBody.password, adminPasswordHash);
  if (!passwordOk) {
    return {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: consentForm(
        validation.client,
        params,
        "Incorrect password. Please try again.",
      ),
    };
  }

  const code = ids.next();
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS);

  await store.saveAuthCode({
    code,
    clientId: validation.client.clientId,
    redirectUri: formBody.redirect_uri,
    scope: formBody.scope ?? "mcp",
    codeChallenge: formBody.code_challenge,
    expiresAt,
    createdAt: now,
    ...(formBody.state !== undefined ? { state: formBody.state } : {}),
  });

  const redirectUrl = new URL(formBody.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (formBody.state !== undefined) {
    redirectUrl.searchParams.set("state", formBody.state);
  }

  return {
    status: 302,
    headers: { Location: redirectUrl.toString() },
    body: "",
  };
}
