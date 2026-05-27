export const maxNoteBodyLength = 1024 * 1024;

export function createSeedState(now = Date.now()) {
  return {
    folders: [
      {
        id: "notes",
        name: "备忘录",
        createdAt: now,
        updatedAt: now
      }
    ],
    notes: [
      {
        id: crypto.randomUUID(),
        folder: "notes",
        body: "欢迎使用备忘录\n\n左侧选择文件夹，中间选择笔记，右侧直接编辑。第一行会自动作为标题。",
        createdAt: now - 1000 * 60 * 60 * 24,
        updatedAt: now - 1000 * 60 * 12,
        version: 1
      },
      {
        id: crypto.randomUUID(),
        folder: "notes",
        body: "待办清单\n\n- 记录想法\n- 整理项目\n- 做一个真正好用的 Web 版笔记",
        createdAt: now - 1000 * 60 * 60 * 3,
        updatedAt: now - 1000 * 60 * 35,
        version: 1
      }
    ]
  };
}

export function normalizeStateForWrite({ folders = [], notes = [] }, now = Date.now()) {
  const normalizedFolders = normalizeFolders(folders, now);
  const folderIds = new Set(normalizedFolders.map((folder) => folder.id));
  const normalizedNotes = notes.map((note) => ({
    id: String(note.id || crypto.randomUUID()),
    folder: folderIds.has(note.folder) ? note.folder : "notes",
    body: clampNoteBody(note.body),
    createdAt: Number(note.createdAt || now),
    updatedAt: Number(note.updatedAt || now),
    version: Number(note.version || 1)
  }));

  return {
    folders: normalizedFolders,
    notes: normalizedNotes
  };
}

function normalizeFolders(folders, now) {
  const seen = new Set();
  const normalized = folders
    .map((folder) => ({
      id: String(folder.id || crypto.randomUUID()),
      name: String(folder.name || "未命名文件夹").trim() || "未命名文件夹",
      createdAt: Number(folder.createdAt || now),
      updatedAt: Number(folder.updatedAt || now),
      version: Number(folder.version || 1)
    }))
    .filter((folder) => {
      if (seen.has(folder.id)) return false;
      seen.add(folder.id);
      return true;
    });

  if (!seen.has("notes")) {
    normalized.unshift({ id: "notes", name: "备忘录", createdAt: now, updatedAt: now, version: 1 });
  }

  return normalized;
}

export function clampNoteBody(value) {
  return String(value || "").slice(0, maxNoteBodyLength);
}
