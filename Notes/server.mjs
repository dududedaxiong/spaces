import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./auth.mjs";
import { createRepository } from "./src/data/repository.mjs";
import { maxNoteBodyLength } from "./src/data/state-utils.mjs";

const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const dataDir = join(root, "data");
const app = new Hono();
mkdirSync(dataDir, { recursive: true });
const repository = createRepository({ dbPath: join(dataDir, "notes.db") });
const sessionCookie = "web_notes_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

await repository.init();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/auth/status", async (c) => {
  const user = await repository.getUser();
  return c.json({
    configured: Boolean(user),
    authenticated: await isAuthenticated(c)
  });
});

app.post("/api/auth/setup", async (c) => {
  const existing = await repository.getUser();
  if (existing) return c.json({ ok: false, error: "already_configured" }, 409);

  const { password } = await c.req.json();
  if (!isValidPassword(password)) {
    return c.json({ ok: false, error: "password_too_short" }, 400);
  }

  await repository.createUser({ passwordHash: await hashPassword(password) });
  await createSession(c);
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const user = await repository.getUser();
  if (!user) return c.json({ ok: false, error: "not_configured" }, 400);

  const { password } = await c.req.json();
  if (!await verifyPassword(password, user.passwordHash)) {
    return c.json({ ok: false, error: "invalid_password" }, 401);
  }

  await createSession(c);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, sessionCookie);
  if (token) {
    await repository.deleteSession(await hashSessionToken(token));
  }
  deleteCookie(c, sessionCookie, { path: "/" });
  return c.json({ ok: true });
});

app.post("/api/auth/password", async (c) => {
  const user = await repository.getUser();
  if (!user) return c.json({ ok: false, error: "not_configured" }, 400);
  if (!await isAuthenticated(c)) return c.json({ ok: false, error: "unauthorized" }, 401);

  const { currentPassword, nextPassword } = await c.req.json();
  if (!await verifyPassword(currentPassword, user.passwordHash)) {
    return c.json({ ok: false, error: "invalid_password" }, 401);
  }
  if (!isValidPassword(nextPassword)) {
    return c.json({ ok: false, error: "password_too_short" }, 400);
  }

  await repository.updateUserPassword({ passwordHash: await hashPassword(nextPassword) });
  await repository.deleteAllSessions();
  await createSession(c);
  return c.json({ ok: true });
});

app.use("/api/state", async (c, next) => {
  const user = await repository.getUser();
  if (!user) return c.json({ ok: false, error: "not_configured" }, 401);
  if (!await isAuthenticated(c)) return c.json({ ok: false, error: "unauthorized" }, 401);
  await next();
});

app.get("/api/state", async (c) => {
  return c.json(await repository.readState());
});

app.put("/api/state", async (c) => {
  const body = await c.req.json();
  const folders = Array.isArray(body.folders) ? body.folders : [];
  const notes = Array.isArray(body.notes) ? body.notes : [];
  return c.json(await repository.writeState({ folders, notes }));
});

app.post("/api/notes", async (c) => {
  const authError = await getAuthError(c);
  if (authError) return authError;
  const body = await c.req.json();
  const lengthError = validateBodyLength(body.body);
  if (lengthError) return c.json(lengthError, 413);
  return c.json(await repository.createNote(body), 201);
});

app.patch("/api/notes/:id", async (c) => {
  const authError = await getAuthError(c);
  if (authError) return authError;
  const body = await c.req.json();
  const lengthError = validateBodyLength(body.body);
  if (lengthError) return c.json(lengthError, 413);

  const result = await repository.updateNote(c.req.param("id"), body);
  if (result.status === "missing") return c.json({ ok: false, error: "not_found" }, 404);
  if (result.status === "conflict") return c.json({ ok: false, error: "conflict", note: result.note }, 409);
  return c.json(result.note);
});

app.delete("/api/notes/:id", async (c) => {
  const authError = await getAuthError(c);
  if (authError) return authError;
  await repository.deleteNote(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/folders", async (c) => {
  const authError = await getAuthError(c);
  if (authError) return authError;
  const body = await c.req.json();
  return c.json(await repository.createFolder(body), 201);
});

app.delete("/api/folders/:id", async (c) => {
  const authError = await getAuthError(c);
  if (authError) return authError;
  const result = await repository.deleteFolder(c.req.param("id"));
  if (result.status === "missing") return c.json({ ok: false, error: "not_found" }, 404);
  return c.json(result);
});

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root)) {
    return c.text("Not found", 404);
  }

  try {
    const file = await readFile(filePath);
    return new Response(file, {
      headers: {
        "content-type": mimeType(extname(filePath))
      }
    });
  } catch {
    const index = await readFile(join(root, "index.html"));
    return new Response(index, {
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    });
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`备忘录 running at http://127.0.0.1:${port}`);
  console.log(`Data repository runtime: ${repository.runtime}`);
});

function mimeType(ext) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function createSession(c) {
  const token = createSessionToken();
  const expiresAt = Date.now() + sessionTtlMs;
  await repository.createSession({
    tokenHash: await hashSessionToken(token),
    expiresAt
  });
  setCookie(c, sessionCookie, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: Math.floor(sessionTtlMs / 1000),
    secure: new URL(c.req.url).protocol === "https:"
  });
}

async function isAuthenticated(c) {
  const token = getCookie(c, sessionCookie);
  if (!token) return false;
  return Boolean(await repository.getSession(await hashSessionToken(token)));
}

async function getAuthError(c) {
  const user = await repository.getUser();
  if (!user) return c.json({ ok: false, error: "not_configured" }, 401);
  if (!await isAuthenticated(c)) return c.json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8;
}

function validateBodyLength(body) {
  if (body === undefined) return null;
  if (String(body).length <= maxNoteBodyLength) return null;
  return {
    ok: false,
    error: "note_too_large",
    maxLength: maxNoteBodyLength
  };
}
