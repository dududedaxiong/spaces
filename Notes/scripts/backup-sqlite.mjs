import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const dataDir = join(root, "data");
const dbPath = join(dataDir, "notes.db");
const remoteFolder = sanitizeRemoteFolder(process.env.REMOTE_FOLDER || "huggingface:notes");
const backupFile = "notes.db";
const uploadFile = "notes.db.uploading";
const mode = process.argv.includes("--restore") ? "restore" : "backup";

try {
  if (mode === "restore") {
    await restoreBackup();
  } else {
    await uploadBackup();
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode,
    error: error.message
  }));
  process.exitCode = 1;
}

async function restoreBackup() {
  mkdirSync(dataDir, { recursive: true });
  const remote = remotePath(backupFile);
  const workDir = mkdtempSync(join(tmpdir(), "notes-restore-"));
  const restorePath = join(workDir, "notes.db");

  const copied = await rclone(["copyto", remote, restorePath], { allowFailure: true });
  if (!copied.ok) {
    rmSync(workDir, { recursive: true, force: true });
    console.log(JSON.stringify({ ok: true, mode: "restore", restored: false, reason: "remote_backup_unavailable" }));
    return;
  }

  assertUsableSqlite(restorePath);
  const restoredSummary = inspectDatabase(restorePath);
  const bytes = statSync(restorePath).size;
  renameSync(restorePath, dbPath);
  rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, mode: "restore", restored: true, remote, bytes, ...restoredSummary }));
}

async function uploadBackup() {
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
    throw new Error("local_database_missing");
  }
  const localSummary = inspectDatabase(dbPath);
  if (localSummary.users === 0) {
    console.log(JSON.stringify({ ok: true, mode: "backup", skipped: true, reason: "database_unconfigured", ...localSummary }));
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "notes-backup-"));
  const snapshotPath = join(workDir, "notes.db");
  createSnapshot(snapshotPath);
  const bytes = statSync(snapshotPath).size;
  const snapshotSummary = inspectDatabase(snapshotPath);

  const uploading = remotePath(uploadFile);
  const target = remotePath(backupFile);
  await rclone(["copyto", snapshotPath, uploading]);
  await rclone(["deletefile", target], { allowFailure: true });
  await rclone(["moveto", uploading, target]);
  await rclone(["touch", target], { allowFailure: true });
  const remoteSummary = await verifyRemoteBackup(target, snapshotSummary);
  rmSync(workDir, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    mode: "backup",
    remote: target,
    bytes,
    ...snapshotSummary,
    remoteVerified: true,
    remoteUsers: remoteSummary.users,
    remoteNotes: remoteSummary.notes,
    remoteFolders: remoteSummary.folders,
    updatedAt: Date.now()
  }));
}

async function verifyRemoteBackup(target, expected) {
  const workDir = mkdtempSync(join(tmpdir(), "notes-verify-"));
  const verifyPath = join(workDir, "notes.db");
  try {
    await rclone(["copyto", target, verifyPath]);
    assertUsableSqlite(verifyPath);
    const actual = inspectDatabase(verifyPath);
    if (actual.users !== expected.users || actual.notes !== expected.notes || actual.folders !== expected.folders) {
      throw new Error("remote_backup_verify_mismatch");
    }
    return actual;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function createSnapshot(snapshotPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO '${escapeSqlitePath(snapshotPath)}'`);
  } finally {
    db.close();
  }
  assertUsableSqlite(snapshotPath);
}

function assertUsableSqlite(path) {
  const db = new DatabaseSync(path);
  try {
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
  } finally {
    db.close();
  }
}

function inspectDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      users: countRows(db, "users"),
      notes: countRows(db, "notes"),
      folders: countRows(db, "folders")
    };
  } finally {
    db.close();
  }
}

function countRows(db, table) {
  const exists = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists?.count) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function rclone(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve({ ok: code === 0, stdout });
        return;
      }
      reject(new Error(`rclone_failed_${code}`));
    });
  });
}

function remotePath(file) {
  return `${remoteFolder.replace(/\/+$/, "")}/${file}`;
}

function sanitizeRemoteFolder(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("remote_folder_missing");
  if (/[\0\r\n]/.test(trimmed)) throw new Error("remote_folder_invalid");
  if (!trimmed.includes(":")) throw new Error("remote_folder_must_include_remote_name");
  return trimmed;
}

function escapeSqlitePath(path) {
  return path.replaceAll("'", "''");
}
