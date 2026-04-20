import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";
import type { PasswordHasher } from "./password.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

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
    .replace(/"/g, "&quot;");

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
.scope{background:#f3f4f6;padding:.5rem;border-radius:4px;font-family:monospace}
</style>
</head>
<body>
<div class="card">
<h1>Authorize access</h1>
<p><strong>${displayName}</strong> is requesting access to your waldo.WTF message lake.</p>
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

export async function handleAuthorizeGet(
  req: AuthorizeGetRequest,
): Promise<AuthorizeGetResponse> {
  const { params, store } = req;

  if (params.response_type !== "code") {
    return errorHtml(400, "response_type must be 'code'");
  }
  if (params.code_challenge_method !== "S256") {
    return errorHtml(
      400,
      "code_challenge_method must be 'S256' (required by OAuth 2.1)",
    );
  }
  if (!params.code_challenge) {
    return errorHtml(400, "code_challenge is required (PKCE)");
  }

  const client = await store.getClient(params.client_id);
  if (!client) {
    return errorHtml(400, `unknown client: ${params.client_id}`);
  }
  if (!client.redirectUris.includes(params.redirect_uri)) {
    return errorHtml(
      400,
      `redirect_uri '${params.redirect_uri}' is not registered for this client`,
    );
  }

  const html = consentForm(client, params);
  return { status: 200, contentType: "text/html; charset=utf-8", body: html };
}

export async function handleAuthorizePost(
  req: AuthorizePostRequest,
): Promise<AuthorizePostResponse> {
  if (req.adminPasswordHash === undefined) {
    return {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<!DOCTYPE html><html><body><h1>503</h1><p>OAuth admin password not configured.</p></body></html>",
    };
  }

  const { formBody, store, hasher, adminPasswordHash, ids, clock } = req;

  const passwordOk = await hasher.verify(formBody.password, adminPasswordHash);
  if (!passwordOk) {
    const client = await store.getClient(formBody.client_id);
    const getParams: AuthorizeGetParams = {
      client_id: formBody.client_id,
      redirect_uri: formBody.redirect_uri,
      response_type: "code",
      code_challenge: formBody.code_challenge,
      code_challenge_method: formBody.code_challenge_method,
      scope: formBody.scope,
      state: formBody.state,
    };
    const html = consentForm(
      client ?? { clientId: formBody.client_id },
      getParams,
      "Incorrect password. Please try again.",
    );
    return {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html,
    };
  }

  const code = ids.next();
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS);

  await store.saveAuthCode({
    code,
    clientId: formBody.client_id,
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
