import { clampNoteBody, createSeedState, normalizeStateForWrite } from "./state-utils.mjs";

export function createD1Repository({ db }) {
  return {
    runtime: "workerd",
    async init() {
      await db.exec(schemaSql);
      await seedDatabase(db);
    },
    async readState() {
      return readState(db);
    },
    async writeState(state) {
      await writeState(db, state);
      return readState(db);
    },
    async createNote(note) {
      return createNote(db, note);
    },
    async updateNote(id, patch) {
      return updateNote(db, id, patch);
    },
    async deleteNote(id) {
      await db.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
    },
    async createFolder(folder) {
      return createFolder(db, folder);
    },
    async updateFolder(id, patch) {
      return updateFolder(db, id, patch);
    },
    async deleteFolder(id) {
      return deleteFolder(db, id);
    },
    async getUser() {
      return await db.prepare("SELECT id, password_hash AS passwordHash, created_at AS createdAt FROM users ORDER BY created_at ASC LIMIT 1").first() || null;
    },
    async createUser({ passwordHash }) {
      const now = Date.now();
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)").bind(id, passwordHash, now).run();
      return { id, passwordHash, createdAt: now };
    },
    async updateUserPassword({ passwordHash }) {
      const user = await this.getUser();
      if (!user) return null;
      await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, user.id).run();
      return { ...user, passwordHash };
    },
    async createSession({ tokenHash, expiresAt }) {
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(id, tokenHash, expiresAt, Date.now()).run();
      return { id, tokenHash, expiresAt };
    },
    async getSession(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()).run();
      return await db.prepare("SELECT id, token_hash AS tokenHash, expires_at AS expiresAt FROM sessions WHERE token_hash = ? LIMIT 1").bind(tokenHash).first() || null;
    },
    async deleteSession(tokenHash) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    },
    async deleteAllSessions() {
      await db.prepare("DELETE FROM sessions").run();
    }
  };
}

const schemaSql = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(folder) REFERENCES folders(id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

async function seedDatabase(db) {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM folders").first();
  if (existing?.count > 0) return;
  await writeState(db, createSeedState());
}

async function readState(db) {
  const foldersResult = await db.prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, version
    FROM folders
    ORDER BY created_at ASC
  `).all();
  const notesResult = await db.prepare(`
    SELECT id, folder, body, created_at AS createdAt, updated_at AS updatedAt, version
    FROM notes
    ORDER BY updated_at DESC
  `).all();

  return {
    folders: foldersResult.results || [],
    notes: notesResult.results || []
  };
}

async function writeState(db, state) {
  const { folders, notes } = normalizeStateForWrite(state);
  const statements = [
    db.prepare("DELETE FROM notes"),
    db.prepare("DELETE FROM folders"),
    ...folders.map((folder) => db.prepare(`
      INSERT INTO folders (id, name, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?)
    `).bind(folder.id, folder.name, folder.createdAt, folder.updatedAt, folder.version)),
    ...notes.map((note) => db.prepare(`
      INSERT INTO notes (id, folder, body, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(note.id, note.folder, note.body, note.createdAt, note.updatedAt, note.version))
  ];

  await db.batch(statements);
}

async function createNote(db, note) {
  const now = Date.now();
  const folder = await db.prepare("SELECT id FROM folders WHERE id = ? LIMIT 1").bind(note.folder).first();
  const folderId = folder?.id || "notes";
  const createdAt = Number(note.createdAt || now);
  const updatedAt = Number(note.updatedAt || now);
  const id = String(note.id || crypto.randomUUID());
  await db.prepare(`
    INSERT INTO notes (id, folder, body, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `).bind(id, folderId, clampNoteBody(note.body), createdAt, updatedAt).run();
  return getNote(db, id);
}

async function updateNote(db, id, patch) {
  const existing = await getNote(db, id);
  if (!existing) return { status: "missing" };
  const expectedVersion = Number(patch.version);
  if (expectedVersion && expectedVersion !== existing.version) {
    return { status: "conflict", note: existing };
  }
  const folder = patch.folder ? await db.prepare("SELECT id FROM folders WHERE id = ? LIMIT 1").bind(patch.folder).first() : null;
  const nextFolder = folder?.id || existing.folder;
  const nextBody = patch.body === undefined ? existing.body : clampNoteBody(patch.body);
  const nextUpdatedAt = Number(patch.updatedAt || Date.now());
  const nextVersion = existing.version + 1;
  await db.prepare(`
    UPDATE notes
    SET folder = ?, body = ?, updated_at = ?, version = ?
    WHERE id = ?
  `).bind(nextFolder, nextBody, nextUpdatedAt, nextVersion, id).run();
  return { status: "ok", note: await getNote(db, id) };
}

async function getNote(db, id) {
  return await db.prepare(`
    SELECT id, folder, body, created_at AS createdAt, updated_at AS updatedAt, version
    FROM notes
    WHERE id = ?
    LIMIT 1
  `).bind(id).first() || null;
}

async function createFolder(db, folder) {
  const now = Date.now();
  const id = String(folder.id || crypto.randomUUID());
  const name = String(folder.name || "未命名文件夹").trim() || "未命名文件夹";
  const createdAt = Number(folder.createdAt || now);
  const updatedAt = Number(folder.updatedAt || now);
  await db.prepare(`
    INSERT INTO folders (id, name, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 1)
  `).bind(id, name, createdAt, updatedAt).run();
  return getFolder(db, id);
}

async function updateFolder(db, id, patch) {
  const existing = await getFolder(db, id);
  if (!existing || existing.id === "notes") return { status: "missing" };
  const expectedVersion = Number(patch.version);
  if (expectedVersion && expectedVersion !== existing.version) {
    return { status: "conflict", folder: existing };
  }

  const nextName = String(patch.name ?? existing.name).trim() || existing.name;
  const nextUpdatedAt = Number(patch.updatedAt || Date.now());
  const nextVersion = existing.version + 1;
  await db.prepare(`
    UPDATE folders
    SET name = ?, updated_at = ?, version = ?
    WHERE id = ?
  `).bind(nextName, nextUpdatedAt, nextVersion, id).run();
  return { status: "ok", folder: await getFolder(db, id) };
}

async function deleteFolder(db, id) {
  const folder = await getFolder(db, id);
  if (!folder || folder.id === "notes") return { status: "missing" };
  const fallback = await getFolder(db, "notes") || await db.prepare("SELECT id FROM folders ORDER BY created_at ASC LIMIT 1").first();
  if (!fallback) return { status: "missing" };
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE notes SET folder = ?, updated_at = ?, version = version + 1 WHERE folder = ?").bind(fallback.id, now, folder.id),
    db.prepare("DELETE FROM folders WHERE id = ?").bind(folder.id)
  ]);
  return { status: "ok", fallbackFolderId: fallback.id };
}

async function getFolder(db, id) {
  return await db.prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, version
    FROM folders
    WHERE id = ?
    LIMIT 1
  `).bind(id).first() || null;
}
