/**
 * Taiga HTTP client.
 *
 * Supports GET for discovery and PATCH for Task status and comments.
 * There are no methods for attachments, webhooks, or creating/deleting
 * board items.
 *
 * Authentication uses Taiga Cloud login/refresh when credentials are
 * configured. TAIGA_TOKEN remains a temporary fallback only.
 */

import dotenv from "dotenv";
import {
  defaultTaigaSessionPath,
  hasLoginCredentials,
  loginTaigaSession,
  persistRotatedRefreshToken,
  readTaigaSession,
  refreshTaigaSession,
  type TaigaAuthOptions,
  type TaigaAuthTokens,
} from "./auth.js";

export interface TaigaClientConfig {
  baseUrl: string;
  token?: string;
  authScheme?: "Bearer" | "Application";
  username?: string;
  password?: string;
  sessionPath?: string;
  fetchImpl?: typeof fetch;
}

const ALLOWED_AUTH_SCHEMES = new Set(["Bearer", "Application"]);
const CONFIG_ERROR =
  "Taiga authentication is not configured. Set TAIGA_USERNAME and TAIGA_PASSWORD, or provide a stored session in .taiga-auth.json, or set TAIGA_TOKEN as a temporary fallback.";

export function createTaigaClientFromEnv(): TaigaClient {
  dotenv.config();

  return new TaigaClient({
    baseUrl: resolveApiBaseUrl(
      process.env.TAIGA_BASE_URL?.trim() || "https://api.taiga.io"
    ),
    token: normalizeTokenValue(process.env.TAIGA_TOKEN) || undefined,
    authScheme: normalizeAuthScheme(process.env.TAIGA_AUTH_SCHEME),
    username: process.env.TAIGA_USERNAME?.trim() || undefined,
    password: process.env.TAIGA_PASSWORD || undefined,
    sessionPath: defaultTaigaSessionPath(),
  });
}

export class TaigaClient {
  private accessToken?: string;
  private authScheme: "Bearer" | "Application";
  private authPromise?: Promise<void>;
  private recoverPromise?: Promise<boolean>;

  constructor(private readonly config: TaigaClientConfig) {
    this.authScheme = config.authScheme ?? "Bearer";
  }

  async getJson<T>(pathAndQuery: string): Promise<T> {
    const response = await this.request("GET", pathAndQuery);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Taiga GET ${pathAndQuery} failed (${response.status} ${response.statusText}): ${sanitizeErrorText(text)}`
      );
    }

    if (!text.trim()) {
      throw new Error(`Taiga GET ${pathAndQuery} returned an empty body`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Taiga GET ${pathAndQuery} did not return JSON`);
    }
  }

  async getJsonList<T>(pathAndQuery: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = pathAndQuery;

    while (next) {
      const response = await this.request("GET", next);
      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Taiga GET ${next} failed (${response.status} ${response.statusText}): ${sanitizeErrorText(text)}`
        );
      }

      const parsed: unknown = JSON.parse(text);

      if (!Array.isArray(parsed)) {
        throw new Error(`Taiga GET ${next} did not return a JSON array`);
      }

      items.push(...(parsed as T[]));
      next = relativeNextPage(response.headers.get("x-pagination-next"));
    }

    return items;
  }

  async patchJson<T>(pathAndQuery: string, body: unknown): Promise<T> {
    const response = await this.request("PATCH", pathAndQuery, body);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Taiga PATCH ${pathAndQuery} failed (${response.status} ${response.statusText}): ${sanitizeErrorText(text)}`
      );
    }

    if (!text.trim()) {
      throw new Error(`Taiga PATCH ${pathAndQuery} returned an empty body`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Taiga PATCH ${pathAndQuery} did not return JSON`);
    }
  }

  private async request(
    method: "GET" | "PATCH",
    pathAndQuery: string,
    body?: unknown,
    recoverOn401 = true
  ): Promise<Response> {
    await this.ensureAuthenticated();
    const response = await this.send(method, pathAndQuery, body);

    if (response.status === 401 && recoverOn401) {
      const recovered = await this.recoverAuthentication();
      if (recovered) {
        return this.request(method, pathAndQuery, body, false);
      }
    }

    return response;
  }

  private async send(
    method: "GET" | "PATCH",
    pathAndQuery: string,
    body?: unknown
  ): Promise<Response> {
    const url = toAbsoluteUrl(this.config.baseUrl, pathAndQuery);
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: authorizationHeader(this.authScheme, this.accessToken ?? ""),
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (method === "GET") {
      headers["x-disable-pagination"] = "True";
    }

    return fetchImpl(url, {
      method,
      headers,
      body: method === "PATCH" ? JSON.stringify(body) : undefined,
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.accessToken) {
      return;
    }

    if (!this.authPromise) {
      this.authPromise = this.authenticate({ allowFallback: true }).finally(
        () => {
          this.authPromise = undefined;
        }
      );
    }

    await this.authPromise;
  }

  private recoverAuthentication(): Promise<boolean> {
    if (!this.recoverPromise) {
      this.recoverPromise = this.authenticate({ allowFallback: false })
        .then(() => true)
        .catch(() => false)
        .finally(() => {
          this.recoverPromise = undefined;
        });
    }

    return this.recoverPromise;
  }

  private async authenticate(options: {
    allowFallback: boolean;
  }): Promise<void> {
    const authOptions = this.authOptions();
    const sessionPath = authOptions.sessionPath ?? defaultTaigaSessionPath();
    const session = await readTaigaSession(sessionPath);
    const canLogin = hasLoginCredentials(
      this.config.username,
      this.config.password
    );
    const canUseSession = Boolean(session?.refresh);

    if (canUseSession || canLogin) {
      if (session?.refresh) {
        const refreshed = await refreshTaigaSession(authOptions, session.refresh);
        if (refreshed) {
          this.applyLoginTokens(refreshed);
          await persistRotatedRefreshToken(
            sessionPath,
            refreshed,
            session.refresh
          );
          return;
        }
      }

      if (canLogin) {
        const loggedIn = await loginTaigaSession(authOptions);
        this.applyLoginTokens(loggedIn);
        await persistRotatedRefreshToken(
          sessionPath,
          loggedIn,
          session?.refresh
        );
        return;
      }
    }

    if (options.allowFallback && this.config.token) {
      this.accessToken = this.config.token;
      this.authScheme = this.config.authScheme ?? "Bearer";
      return;
    }

    if (!options.allowFallback) {
      throw new Error("Taiga authentication recovery failed.");
    }

    throw new Error(CONFIG_ERROR);
  }

  private applyLoginTokens(tokens: TaigaAuthTokens): void {
    this.accessToken = tokens.authToken;
    this.authScheme = "Bearer";
  }

  private authOptions(): TaigaAuthOptions {
    return {
      baseUrl: this.config.baseUrl,
      username: this.config.username,
      password: this.config.password,
      sessionPath: this.config.sessionPath ?? defaultTaigaSessionPath(),
      fetchImpl: this.config.fetchImpl,
    };
  }
}

function authorizationHeader(
  scheme: "Bearer" | "Application",
  token: string
): string {
  return `${scheme} ${token}`;
}

function normalizeAuthScheme(
  value: string | undefined
): "Bearer" | "Application" {
  const scheme = value?.trim() || "Bearer";
  if (!ALLOWED_AUTH_SCHEMES.has(scheme)) {
    throw new Error(
      `Unsupported TAIGA_AUTH_SCHEME "${scheme}". Use Bearer or Application.`
    );
  }
  return scheme as "Bearer" | "Application";
}

/**
 * TAIGA_TOKEN must be the credential only.
 * If the env value accidentally includes a scheme or extra copy-pasted
 * words, keep the token segment and never log it.
 */
function normalizeTokenValue(value: string | undefined): string {
  let token = value?.trim() ?? "";
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  const parts = token.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }

  if (/^(Bearer|Application)$/i.test(parts[0] ?? "")) {
    parts.shift();
  }

  const credential = parts[0]?.trim() ?? "";
  if (!credential) {
    return "";
  }

  if (/\s/.test(credential)) {
    throw new Error(
      "TAIGA_TOKEN must be a single credential with no spaces. Do not include the Authorization scheme in the token value."
    );
  }

  return credential;
}

export function resolveApiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");

  if (/tree\.taiga\.io/i.test(trimmed)) {
    return "https://api.taiga.io/api/v1";
  }

  if (trimmed.endsWith("/api/v1")) {
    return trimmed;
  }

  return `${trimmed}/api/v1`;
}

function toAbsoluteUrl(baseUrl: string, pathAndQuery: string): string {
  if (/^https?:\/\//i.test(pathAndQuery)) {
    return pathAndQuery;
  }

  const path = pathAndQuery.startsWith("/")
    ? pathAndQuery
    : `/${pathAndQuery}`;
  return `${baseUrl}${path}`;
}

function relativeNextPage(header: string | null): string | undefined {
  const value = header?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

function sanitizeErrorText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Application\s+\S+/gi, "Application [redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted-token]"
    )
    .replace(
      /"(auth_token|refresh|password|token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"'
    );

  if (redacted.length <= 300) {
    return redacted;
  }

  return `${redacted.slice(0, 300)}…`;
}
