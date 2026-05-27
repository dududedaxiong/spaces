import { DatabaseSync } from "node:sqlite";
import { clampNoteBody, createSeedState, normalizeStateForWrite } from "./state-utils.mjs";

export function createSqliteRepository({ dbPath }) {
  const db = new DatabaseSync(dbPath);

  return {
    runtime: "node",
    async init() {
      db.exec(schemaSql);
      seedDatabase(db);
    },
    async readState() {
      return readState(db);
    },
    async writeState(state) {
      writeState(db, state);
      return readState(db);
    },
    async createNote(note) {
      return createNote(db, note);
    },
    async updateNote(id, patch) {
      return updateNote(db, id, patch);
    },
    async deleteNote(id) {
      db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    },
    async createFolder(folder) {
      return createFolder(db, folder);
    },
    async deleteFolder(id) {
      return deleteFolder(db, id);
    },
    async getUser() {
      return db.prepare("SELECT id, password_hash AS passwordHash, created_at AS createdAt FROM users ORDER BY created_at ASC LIMIT 1").get() || null;
    },
    async updateUserPassword({ passwordHash }) {
      const user = await this.getUser();
      if (!user) return null;
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
      return { ...user, passwordHash };
    },
    async createUser({ passwordHash }) {
      const now = Date.now();
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)").run(id, passwordHash, now);
      return { id, passwordHash, createdAt: now };
    },
    async createSession({ tokenHash, expiresAt }) {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").run(id, tokenHash, expiresAt, Date.now());
      return { id, tokenHash, expiresAt };
    },
    async getSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      return db.prepare("SELECT id, token_hash AS tokenHash, expires_at AS expiresAt FROM sessions WHERE token_hash = ? LIMIT 1").get(tokenHash) || null;
    },
    async deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    async deleteAllSessions() {
      db.prepare("DELETE FROM sessions").run();
    }
  };
}

const schemaSql = `
  PRAGMA journal_mode = WAL;
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

function seedDatabase(db) {
  migrateDatabase(db);
  const existing = db.prepare("SELECT COUNT(*) AS count FROM folders").get();
  if (existing.count > 0) return;
  writeState(db, createSeedState());
}

function migrateDatabase(db) {
  addColumnIfMissing(db, "folders", "version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "notes", "version", "INTEGER NOT NULL DEFAULT 1");
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function readState(db) {
  const folders = db.prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, version
    FROM folders
    ORDER BY created_at ASC
  `).all();
  const notes = db.prepare(`
    SELECT id, folder, body, created_at AS createdAt, updated_at AS updatedAt, version
    FROM notes
    ORDER BY updated_at DESC
  `).all();

  return { folders, notes };
}

function writeState(db, state) {
  const { folders, notes } = normalizeStateForWrite(state);
  const insertFolder = db.prepare(`
    INSERT INTO folders (id, name, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertNote = db.prepare(`
    INSERT INTO notes (id, folder, body, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM notes");
    db.exec("DELETE FROM folders");
    folders.forEach((folder) => {
      insertFolder.run(folder.id, folder.name, folder.createdAt, folder.updatedAt, folder.version);
    });
    notes.forEach((note) => {
      insertNote.run(note.id, note.folder, note.body, note.createdAt, note.updatedAt, note.version);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createNote(db, note) {
  const now = Date.now();
  const folder = db.prepare("SELECT id FROM folders WHERE id = ? LIMIT 1").get(note.folder);
  const folderId = folder?.id || "notes";
  const createdAt = Number(note.createdAt || now);
  const updatedAt = Number(note.updatedAt || now);
  const id = String(note.id || crypto.randomUUID());
  db.prepare(`
    INSERT INTO notes (id, folder, body, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, folderId, clampNoteBody(note.body), createdAt, updatedAt);
  return getNote(db, id);
}

function updateNote(db, id, patch) {
  const existing = getNote(db, id);
  if (!existing) return { status: "missing" };
  const expectedVersion = Number(patch.version);
  if (expectedVersion && expectedVersion !== existing.version) {
    return { status: "conflict", note: existing };
  }

  const folder = patch.folder && db.prepare("SELECT id FROM folders WHERE id = ? LIMIT 1").get(patch.folder);
  const nextFolder = folder?.id || existing.folder;
  const nextBody = patch.body === undefined ? existing.body : clampNoteBody(patch.body);
  const nextUpdatedAt = Number(patch.updatedAt || Date.now());
  const nextVersion = existing.version + 1;

  db.prepare(`
    UPDATE notes
    SET folder = ?, body = ?, updated_at = ?, version = ?
    WHERE id = ?
  `).run(nextFolder, nextBody, nextUpdatedAt, nextVersion, id);

  return { status: "ok", note: getNote(db, id) };
}

function getNote(db, id) {
  return db.prepare(`
    SELECT id, folder, body, created_at AS createdAt, updated_at AS updatedAt, version
    FROM notes
    WHERE id = ?
    LIMIT 1
  `).get(id) || null;
}

function createFolder(db, folder) {
  const now = Date.now();
  const id = String(folder.id || crypto.randomUUID());
  const name = String(folder.name || "未命名文件夹").trim() || "未命名文件夹";
  const createdAt = Number(folder.createdAt || now);
  const updatedAt = Number(folder.updatedAt || now);
  db.prepare(`
    INSERT INTO folders (id, name, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 1)
  `).run(id, name, createdAt, updatedAt);
  return getFolder(db, id);
}

function deleteFolder(db, id) {
  const folder = getFolder(db, id);
  if (!folder || folder.id === "notes") return { status: "missing" };
  const fallback = getFolder(db, "notes") || db.prepare("SELECT id FROM folders ORDER BY created_at ASC LIMIT 1").get();
  if (!fallback) return { status: "missing" };
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE notes SET folder = ?, updated_at = ?, version = version + 1 WHERE folder = ?").run(fallback.id, now, folder.id);
    db.prepare("DELETE FROM folders WHERE id = ?").run(folder.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { status: "ok", fallbackFolderId: fallback.id };
}

function getFolder(db, id) {
  return db.prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, version
    FROM folders
    WHERE id = ?
    LIMIT 1
  `).get(id) || null;
}
