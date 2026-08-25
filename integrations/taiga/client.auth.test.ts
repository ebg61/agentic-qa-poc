import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaigaClient } from "./client.js";
import type { TaigaAuthSession } from "./auth.js";

const BASE_URL = "https://api.taiga.io/api/v1";

test("existing refresh token is used and the new access token is sent", async () => {
  const sessionPath = await tempSessionPath({ refresh: "refresh-current" });
  const calls = recordCalls();

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        return jsonResponse(200, {
          auth_token: "access-from-refresh",
          refresh: "refresh-rotated",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        assert.equal(
          header(init, "authorization"),
          "Bearer access-from-refresh"
        );
        return jsonResponse(200, { id: 1, name: "Demo", slug: "demo" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  const project = await client.getJson<{ slug: string }>(
    "/projects/by_slug?slug=demo"
  );

  assert.equal(project.slug, "demo");
  assert.equal(calls.filter((call) => call.url.endsWith("/auth/refresh")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/auth")), false);
  assert.equal((await readSession(sessionPath)).refresh, "refresh-rotated");
});

test("expired refresh token falls back to login, stores the new refresh token, and continues", async () => {
  const sessionPath = await tempSessionPath({ refresh: "refresh-expired" });
  const calls = recordCalls();

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        return jsonResponse(401, { error: "invalid refresh" });
      }

      if (url.endsWith("/auth")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          type?: string;
          username?: string;
        };
        assert.equal(body.type, "normal");
        assert.equal(body.username, "qa-user");
        return jsonResponse(200, {
          auth_token: "access-from-login",
          refresh: "refresh-from-login",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        assert.equal(header(init, "authorization"), "Bearer access-from-login");
        return jsonResponse(200, { id: 1, name: "Demo", slug: "demo" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  await client.getJson("/projects/by_slug?slug=demo");

  assert.equal(calls.filter((call) => call.url.endsWith("/auth/refresh")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth")).length, 1);
  assert.equal((await readSession(sessionPath)).refresh, "refresh-from-login");
});

test("no stored session logs in", async () => {
  const sessionPath = path.join(await mkdtemp(path.join(tmpdir(), "taiga-auth-")), "session.json");
  const calls = recordCalls();

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      const url = String(input);

      if (url.endsWith("/auth")) {
        return jsonResponse(200, {
          auth_token: "access-from-login",
          refresh: "refresh-from-login",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        assert.equal(header(init, "authorization"), "Bearer access-from-login");
        return jsonResponse(200, { id: 2, name: "Demo", slug: "demo" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  await client.getJson("/projects/by_slug?slug=demo");

  assert.equal(calls.some((call) => call.url.endsWith("/auth/refresh")), false);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth")).length, 1);
  assert.equal((await readSession(sessionPath)).refresh, "refresh-from-login");
});

test("API 401 recovers authentication once and retries the original request once", async () => {
  const sessionPath = await tempSessionPath({ refresh: "refresh-current" });
  const calls = recordCalls();
  let projectGets = 0;

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        const refreshCount = calls.filter((call) =>
          call.url.endsWith("/auth/refresh")
        ).length;
        return jsonResponse(200, {
          auth_token: refreshCount === 1 ? "access-first" : "access-recovered",
          refresh: "refresh-current",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        projectGets += 1;
        if (projectGets === 1) {
          assert.equal(header(init, "authorization"), "Bearer access-first");
          return jsonResponse(401, { error: "expired" });
        }

        assert.equal(header(init, "authorization"), "Bearer access-recovered");
        return jsonResponse(200, { id: 1, name: "Demo", slug: "demo" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  const project = await client.getJson<{ id: number }>(
    "/projects/by_slug?slug=demo"
  );

  assert.equal(project.id, 1);
  assert.equal(projectGets, 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth/refresh")).length, 2);
});

test("request fails cleanly when recovery still returns 401", async () => {
  const sessionPath = await tempSessionPath({ refresh: "refresh-current" });
  let projectGets = 0;

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        return jsonResponse(200, {
          auth_token: "access-token",
          refresh: "refresh-current",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        projectGets += 1;
        return jsonResponse(401, { error: "still unauthorized" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  await assert.rejects(
    () => client.getJson("/projects/by_slug?slug=demo"),
    /Taiga GET \/projects\/by_slug\?slug=demo failed \(401/
  );
  assert.equal(projectGets, 2);
});

test("TAIGA_TOKEN fallback is used when username/password and session are unavailable", async () => {
  const sessionPath = path.join(
    await mkdtemp(path.join(tmpdir(), "taiga-auth-")),
    "missing.json"
  );
  const calls = recordCalls();

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    token: "static-fallback-token",
    authScheme: "Bearer",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      assert.equal(header(init, "authorization"), "Bearer static-fallback-token");
      return jsonResponse(200, { id: 9, name: "Demo", slug: "demo" });
    },
  });

  await client.getJson("/projects/by_slug?slug=demo");

  assert.equal(calls.some((call) => call.url.includes("/auth")), false);
});

test("missing credentials, session, and token produce a clear configuration error", async () => {
  const sessionPath = path.join(
    await mkdtemp(path.join(tmpdir(), "taiga-auth-")),
    "missing.json"
  );

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    sessionPath,
    fetchImpl: async () => jsonResponse(500, { error: "should-not-call-api" }),
  });

  await assert.rejects(
    () => client.getJson("/projects/by_slug?slug=demo"),
    /Taiga authentication is not configured/
  );
});

test("username and password are preferred over TAIGA_TOKEN fallback", async () => {
  const sessionPath = path.join(
    await mkdtemp(path.join(tmpdir(), "taiga-auth-")),
    "session.json"
  );
  const calls = recordCalls();

  const client = new TaigaClient({
    baseUrl: BASE_URL,
    token: "should-not-be-used",
    username: "qa-user",
    password: "secret",
    sessionPath,
    fetchImpl: async (input, init) => {
      calls.push(describeCall(input, init));
      const url = String(input);

      if (url.endsWith("/auth")) {
        return jsonResponse(200, {
          auth_token: "access-from-login",
          refresh: "refresh-from-login",
        });
      }

      if (url.endsWith("/projects/by_slug?slug=demo")) {
        assert.equal(header(init, "authorization"), "Bearer access-from-login");
        return jsonResponse(200, { id: 1, name: "Demo", slug: "demo" });
      }

      return jsonResponse(500, { error: "unexpected" });
    },
  });

  await client.getJson("/projects/by_slug?slug=demo");
  assert.equal(calls.some((call) => call.authorization === "Bearer should-not-be-used"), false);
});

type RecordedCall = {
  url: string;
  method: string;
  authorization?: string;
};

function recordCalls(): RecordedCall[] {
  return [];
}

function describeCall(
  input: RequestInfo | URL,
  init?: RequestInit
): RecordedCall {
  return {
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    authorization: header(init, "authorization"),
  };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const record = headers as Record<string, string>;
  return record[name] ?? record.Authorization;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function tempSessionPath(session: TaigaAuthSession): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "taiga-auth-"));
  const sessionPath = path.join(directory, "session.json");
  await writeFile(sessionPath, `${JSON.stringify(session)}\n`, "utf8");
  return sessionPath;
}

async function readSession(sessionPath: string): Promise<TaigaAuthSession> {
  return JSON.parse(await readFile(sessionPath, "utf8")) as TaigaAuthSession;
}
