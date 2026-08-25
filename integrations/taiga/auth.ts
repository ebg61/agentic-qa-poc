/**
 * Taiga Cloud login/refresh for the HTTP client.
 *
 * Uses POST /api/v1/auth and POST /api/v1/auth/refresh.
 * Persists only the refresh token in a local gitignored session file.
 * Never logs passwords or tokens.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const TAIGA_SESSION_FILE = ".taiga-auth.json";

export interface TaigaAuthSession {
  refresh: string;
  updatedAt?: string;
}

export interface TaigaAuthTokens {
  authToken: string;
  refresh?: string;
}

export interface TaigaAuthOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  sessionPath?: string;
  fetchImpl?: typeof fetch;
}

export function defaultTaigaSessionPath(): string {
  return path.resolve(TAIGA_SESSION_FILE);
}

export function hasLoginCredentials(
  username: string | undefined,
  password: string | undefined
): boolean {
  return Boolean(username?.trim() && password);
}

export async function readTaigaSession(
  sessionPath: string
): Promise<TaigaAuthSession | undefined> {
  try {
    const raw = await readFile(sessionPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const refresh = (parsed as { refresh?: unknown }).refresh;
    if (typeof refresh !== "string" || !refresh.trim()) {
      return undefined;
    }

    const updatedAt = (parsed as { updatedAt?: unknown }).updatedAt;
    return {
      refresh: refresh.trim(),
      updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function writeTaigaSession(
  sessionPath: string,
  refresh: string
): Promise<void> {
  const session: TaigaAuthSession = {
    refresh,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(sessionPath, 0o600).catch(() => undefined);
}

export async function refreshTaigaSession(
  options: TaigaAuthOptions,
  refreshToken: string
): Promise<TaigaAuthTokens | undefined> {
  const response = await postAuthJson(options, "/auth/refresh", {
    refresh: refreshToken,
  });

  if (!response) {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  return parseAuthTokens(await readResponseJson(response));
}

export async function loginTaigaSession(
  options: TaigaAuthOptions
): Promise<TaigaAuthTokens> {
  const username = options.username?.trim();
  const password = options.password;
  if (!username || !password) {
    throw new Error(
      "Taiga login requires TAIGA_USERNAME and TAIGA_PASSWORD."
    );
  }

  const response = await postAuthJson(options, "/auth", {
    type: "normal",
    username,
    password,
  });

  if (!response) {
    throw new Error("Taiga login failed. The authentication request did not complete.");
  }

  if (!response.ok) {
    throw new Error(
      "Taiga login failed. Check TAIGA_USERNAME and TAIGA_PASSWORD."
    );
  }

  const tokens = parseAuthTokens(await readResponseJson(response));
  if (!tokens) {
    throw new Error("Taiga login did not return an access token.");
  }

  return tokens;
}

export async function persistRotatedRefreshToken(
  sessionPath: string,
  tokens: TaigaAuthTokens,
  previousRefresh?: string
): Promise<void> {
  const refresh = tokens.refresh?.trim() || previousRefresh?.trim();
  if (!refresh) {
    return;
  }

  await writeTaigaSession(sessionPath, refresh);
}

function parseAuthTokens(value: unknown): TaigaAuthTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const authToken =
    typeof record.auth_token === "string" ? record.auth_token.trim() : "";
  if (!authToken) {
    return undefined;
  }

  const refresh =
    typeof record.refresh === "string" && record.refresh.trim()
      ? record.refresh.trim()
      : undefined;

  return { authToken, refresh };
}

async function postAuthJson(
  options: TaigaAuthOptions,
  apiPath: string,
  body: unknown
): Promise<Response | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;

  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return undefined;
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
