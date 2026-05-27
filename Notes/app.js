const uiStorageKey = "memo-ui-state-v1";

if (new URLSearchParams(window.location.search).get("device") === "mobile") {
  document.documentElement.classList.add("force-mobile");
}

const starterNotes = [
  {
    id: crypto.randomUUID(),
    folder: "notes",
    body: "欢迎使用备忘录\n\n左侧选择文件夹，中间选择笔记，右侧直接编辑。第一行会自动作为标题。",
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    updatedAt: Date.now() - 1000 * 60 * 12,
    version: 1
  },
  {
    id: crypto.randomUUID(),
    folder: "notes",
    body: "待办清单\n\n- 记录想法\n- 整理项目\n- 做一个真正好用的 Web 版笔记",
    createdAt: Date.now() - 1000 * 60 * 60 * 3,
    updatedAt: Date.now() - 1000 * 60 * 35,
    version: 1
  }
];

const authStatus = await getAuthStatus();
const state = authStatus.authenticated
  ? await loadState()
  : hydrateState({ notes: [], folders: defaultFolders() });
let saveTimer = null;
let saveStatusTimer = null;
const saveDelay = 700;
const maxNoteBodyLength = 1024 * 1024;
const els = {
  authGate: document.querySelector("#authGate"),
  authForm: document.querySelector("#authForm"),
  authTitle: document.querySelector("#authTitle"),
  authPassword: document.querySelector("#authPassword"),
  authSubmit: document.querySelector("#authSubmit"),
  authMessage: document.querySelector("#authMessage"),
  passwordGate: document.querySelector("#passwordGate"),
  passwordForm: document.querySelector("#passwordForm"),
  currentPassword: document.querySelector("#currentPassword"),
  nextPassword: document.querySelector("#nextPassword"),
  confirmPassword: document.querySelector("#confirmPassword"),
  cancelPassword: document.querySelector("#cancelPassword"),
  submitPassword: document.querySelector("#submitPassword"),
  passwordMessage: document.querySelector("#passwordMessage"),
  folderList: document.querySelector("#folderList"),
  newFolder: document.querySelector("#newFolder"),
  listTitle: document.querySelector("#listTitle"),
  listCount: document.querySelector("#listCount"),
  noteList: document.querySelector("#noteList"),
  newNote: document.querySelector("#newNote"),
  deleteNote: document.querySelector("#deleteNote"),
  previewToggle: document.querySelector("#previewToggle"),
  changePassword: document.querySelector("#changePassword"),
  logout: document.querySelector("#logout"),
  searchInput: document.querySelector("#searchInput"),
  mobileBack: document.querySelector("#mobileBack"),
  mobileBackLabel: document.querySelector("#mobileBackLabel"),
  mobileTitle: document.querySelector("#mobileTitle"),
  mobileSearchInput: document.querySelector("#mobileSearchInput"),
  mobileSearchWrap: document.querySelector("#mobileSearchWrap"),
  mobileEdit: document.querySelector("#mobileEdit"),
  mobilePreviewToggle: document.querySelector("#mobilePreviewToggle"),
  mobileSave: document.querySelector("#mobileSave"),
  mobileMore: document.querySelector("#mobileMore"),
  mobileActionMenu: document.querySelector("#mobileActionMenu"),
  mobileMenuPreview: document.querySelector("#mobileMenuPreview"),
  mobileMenuSave: document.querySelector("#mobileMenuSave"),
  mobileMenuDelete: document.querySelector("#mobileMenuDelete"),
  mobileNoteFolderSelect: document.querySelector("#mobileNoteFolderSelect"),
  appShell: document.querySelector(".app-shell"),
  editor: document.querySelector("#editor"),
  noteFolderSelect: document.querySelector("#noteFolderSelect"),
  editorPreviewToggle: document.querySelector("#editorPreviewToggle"),
  saveNote: document.querySelector("#saveNote"),
  saveStatus: document.querySelector("#saveStatus"),
  editedAt: document.querySelector("#editedAt"),
  markdownPreview: document.querySelector("#markdownPreview"),
  editorPane: document.querySelector(".editor-pane")
};

render();
if (authStatus.authenticated) {
  hideAuthGate();
} else {
  showAuthGate(authStatus.configured);
}

window.addEventListener("beforeunload", flushPendingSave);

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = els.authPassword.value;
  els.authSubmit.disabled = true;
  els.authMessage.textContent = "";

  try {
    const path = authStatus.configured ? "/api/auth/login" : "/api/auth/setup";
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      const message = response.status === 401 ? "密码不正确" : "密码至少需要 8 位";
      els.authMessage.textContent = message;
      return;
    }
    location.reload();
  } finally {
    els.authSubmit.disabled = false;
  }
});

els.newNote.addEventListener("click", async () => {
  const now = Date.now();
  const note = {
    id: crypto.randomUUID(),
    folder: getWriteFolderId(),
    body: "",
    createdAt: now,
    updatedAt: now,
    version: 1
  };

  state.notes.unshift(note);
  if (state.activeFolder === "recent") state.activeFolder = note.folder;
  state.selectedId = note.id;
  state.mobileView = "editor";
  render();
  els.editor.focus();

  try {
    setSaveStatus("保存中");
    const saved = await createNote(note);
    Object.assign(note, saved);
    setSaveStatus("已保存", "ok");
    renderListOnly();
    renderEditor();
  } catch (error) {
    setSaveStatus("保存失败", "error");
    console.error("Failed to create note.", error);
  }
});

els.deleteNote.addEventListener("click", async () => {
  const current = getSelectedNote();
  if (!current) return;

  const visible = getVisibleNotes();
  const index = visible.findIndex((note) => note.id === current.id);
  state.notes = state.notes.filter((note) => note.id !== current.id);
  const next = visible[index + 1] || visible[index - 1];
  state.selectedId = next && state.notes.some((note) => note.id === next.id) ? next.id : null;
  render();

  try {
    await deleteNote(current.id);
    setSaveStatus("已删除", "ok");
  } catch (error) {
    state.notes.unshift(current);
    state.selectedId = current.id;
    setSaveStatus("删除失败", "error");
    render();
    console.error("Failed to delete note.", error);
  }
});

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  const visible = getVisibleNotes();
  if (!visible.some((note) => note.id === state.selectedId)) {
    state.selectedId = visible[0]?.id || null;
  }
  saveUiState();
  render();
});

els.mobileSearchInput.addEventListener("input", (event) => {
  if (state.mobileView === "folders") {
    state.folderQuery = event.target.value;
  } else {
    state.query = event.target.value;
    const visible = getVisibleNotes();
    if (!visible.some((note) => note.id === state.selectedId)) {
      state.selectedId = visible[0]?.id || null;
    }
  }
  saveUiState();
  render();
});

els.mobileBack.addEventListener("click", () => {
  if (state.mobileView === "editor") {
    state.mobileView = "list";
  } else if (state.mobileView === "list") {
    state.mobileView = "folders";
  }
  saveUiState();
  render();
});

els.mobileEdit.addEventListener("click", () => {
  els.newNote.click();
});

els.mobileSave.addEventListener("click", () => {
  if (!getSelectedNote()) return;
  saveSelectedNote({ immediate: true });
});

els.mobilePreviewToggle.addEventListener("click", togglePreviewMode);

els.mobileMore.addEventListener("click", (event) => {
  event.stopPropagation();
  els.mobileActionMenu.hidden = !els.mobileActionMenu.hidden;
});

els.mobileMenuPreview.addEventListener("click", () => {
  els.mobileActionMenu.hidden = true;
  togglePreviewMode();
});

els.mobileMenuSave.addEventListener("click", () => {
  els.mobileActionMenu.hidden = true;
  if (getSelectedNote()) saveSelectedNote({ immediate: true });
});

els.mobileMenuDelete.addEventListener("click", () => {
  els.mobileActionMenu.hidden = true;
  els.deleteNote.click();
});

document.addEventListener("click", (event) => {
  if (els.mobileActionMenu.hidden) return;
  if (event.target.closest("#mobileActions")) return;
  els.mobileActionMenu.hidden = true;
});

els.newFolder.addEventListener("click", async () => {
  const name = getUniqueFolderName("新建文件夹");
  const folder = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1
  };

  state.folders.push(folder);
  state.activeFolder = folder.id;
  state.selectedId = null;
  state.mobileView = "list";
  render();

  try {
    const saved = await createFolder(folder);
    Object.assign(folder, saved);
    setSaveStatus("文件夹已创建", "ok");
    renderFolders();
    renderEditor();
  } catch (error) {
    state.folders = state.folders.filter((entry) => entry.id !== folder.id);
    state.activeFolder = "all";
    setSaveStatus("创建失败", "error");
    render();
    console.error("Failed to create folder.", error);
  }
});

els.editor.addEventListener("input", (event) => {
  const note = getSelectedNote();
  if (!note) return;

  if (event.target.value.length > maxNoteBodyLength) {
    event.target.value = event.target.value.slice(0, maxNoteBodyLength);
    setSaveStatus("内容已达上限", "error");
  }

  note.body = event.target.value;
  note.updatedAt = Date.now();
  saveSelectedNote();
  renderListOnly();
  updateEditorMeta(note);
  renderMarkdownPreview(note);
});

els.noteFolderSelect.addEventListener("change", (event) => {
  moveSelectedNoteToFolder(event.target.value);
});

els.saveNote.addEventListener("click", () => {
  if (!getSelectedNote()) return;
  saveSelectedNote({ immediate: true });
});

els.mobileNoteFolderSelect.addEventListener("change", (event) => {
  els.mobileActionMenu.hidden = true;
  moveSelectedNoteToFolder(event.target.value);
});

els.previewToggle.addEventListener("click", togglePreviewMode);
els.editorPreviewToggle.addEventListener("click", togglePreviewMode);

els.logout.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
});

els.changePassword.addEventListener("click", async () => {
  showPasswordGate();
});

els.cancelPassword.addEventListener("click", hidePasswordGate);

els.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = els.currentPassword.value;
  const nextPassword = els.nextPassword.value;
  const confirmPassword = els.confirmPassword.value;
  els.passwordMessage.textContent = "";

  if (nextPassword !== confirmPassword) {
    els.passwordMessage.textContent = "两次输入的新密码不一致";
    return;
  }

  els.submitPassword.disabled = true;
  try {
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, nextPassword })
    });
    if (!response.ok) {
      const message = response.status === 401 ? "当前密码不正确" : "新密码至少需要 8 位";
      els.passwordMessage.textContent = message;
      return;
    }
    hidePasswordGate();
    window.alert("密码已修改");
  } catch (error) {
    els.passwordMessage.textContent = "修改失败，请稍后再试";
    console.error("Failed to change password.", error);
  } finally {
    els.submitPassword.disabled = false;
  }
});

function moveSelectedNoteToFolder(nextFolder) {
  const note = getSelectedNote();
  if (!note) return;

  if (!state.folders.some((folder) => folder.id === nextFolder)) return;

  note.folder = nextFolder;
  note.updatedAt = Date.now();
  state.activeFolder = nextFolder;
  saveSelectedNote({ immediate: true });
  render();
}

function togglePreviewMode() {
  state.previewMode = !state.previewMode;
  saveUiState();
  renderEditor();
  renderMobileChrome();
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    els.newNote.click();
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (getSelectedNote()) saveSelectedNote({ immediate: true });
  }

  if (event.key === "Delete" && document.activeElement !== els.editor) {
    els.deleteNote.click();
  }
});

async function loadState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`State API returned ${response.status}`);
    return hydrateState(await response.json());
  } catch (error) {
    console.warn("Falling back to starter notes because the API is unavailable.", error);
    return hydrateState({ notes: starterNotes, folders: defaultFolders() });
  }
}

async function getAuthStatus() {
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) throw new Error(`Auth API returned ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("Auth API unavailable.", error);
    return { configured: false, authenticated: false };
  }
}

function showAuthGate(configured) {
  els.authGate.setAttribute("aria-busy", "false");
  els.authTitle.textContent = configured ? "登录" : "设置密码";
  els.authPassword.autocomplete = configured ? "current-password" : "new-password";
  els.authPassword.placeholder = configured ? "密码" : "设置至少 8 位密码";
  els.authSubmit.textContent = configured ? "登录" : "创建";
  els.authGate.hidden = false;
  els.authPassword.focus();
}

function hideAuthGate() {
  els.authGate.hidden = true;
  els.authGate.setAttribute("aria-busy", "false");
}

function showPasswordGate() {
  els.passwordForm.reset();
  els.passwordMessage.textContent = "";
  els.passwordGate.hidden = false;
  els.currentPassword.focus();
}

function hidePasswordGate() {
  els.passwordGate.hidden = true;
  els.passwordForm.reset();
  els.passwordMessage.textContent = "";
}

function saveSelectedNote({ immediate = false } = {}) {
  saveUiState();
  const note = getSelectedNote();
  if (!note) return;
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) {
    saveTimer = null;
    sendNote(note.id);
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    sendNote(note.id);
  }, saveDelay);
  setSaveStatus("未保存");
}

function flushPendingSave() {
  saveUiState();
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const note = getSelectedNote();
  if (note) sendNote(note.id, { keepalive: true });
}

async function sendNote(noteId, { keepalive = false } = {}) {
  const note = state.notes.find((entry) => entry.id === noteId);
  if (!note) return;

  setSaveStatus("保存中");
  try {
    const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: "PATCH",
      keepalive,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        folder: note.folder,
        body: note.body,
        updatedAt: note.updatedAt,
        version: note.version
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.note) {
      handleNoteConflict(note, payload.note);
      return;
    }
    if (!response.ok) {
      throw new Error(payload.error || `Save API returned ${response.status}`);
    }
    Object.assign(note, payload);
    setSaveStatus("已保存", "ok");
    renderListOnly();
    renderEditor();
  } catch (error) {
    setSaveStatus("保存失败", "error");
    console.error("Failed to save note.", error);
  }
}

async function createNote(note) {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(note)
  });
  if (!response.ok) throw new Error(`Create note API returned ${response.status}`);
  return await response.json();
}

async function deleteNote(noteId) {
  const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Delete note API returned ${response.status}`);
}

async function createFolder(folder) {
  const response = await fetch("/api/folders", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(folder)
  });
  if (!response.ok) throw new Error(`Create folder API returned ${response.status}`);
  return await response.json();
}

async function removeFolder(folderId) {
  const response = await fetch(`/api/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Delete folder API returned ${response.status}`);
  return await response.json();
}

function handleNoteConflict(localNote, serverNote) {
  setSaveStatus("有冲突", "conflict");
  const useServer = window.confirm("这条笔记已在其他设备修改。确定载入服务器版本吗？取消则保留本机内容，稍后可再次保存。");
  if (useServer) {
    Object.assign(localNote, serverNote);
    setSaveStatus("已载入服务器版本", "ok");
    render();
    return;
  }
  localNote.version = serverNote.version;
  setSaveStatus("保留本机内容", "conflict");
}

function setSaveStatus(text, type = "") {
  els.saveStatus.textContent = text;
  els.saveStatus.className = `save-status${type ? ` is-${type}` : ""}`;
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  if (type === "ok") {
    saveStatusTimer = setTimeout(() => {
      els.saveStatus.textContent = "";
      els.saveStatus.className = "save-status";
    }, 1800);
  }
}

function hydrateState(data) {
  const folders = Array.isArray(data.folders) && data.folders.length ? data.folders : defaultFolders();
  const notes = Array.isArray(data.notes)
    ? data.notes.map((note) => ({ ...note, version: Number(note.version || 1) }))
    : [];
  const ui = loadUiState();
  const selectedId = notes.some((note) => note.id === ui.selectedId) ? ui.selectedId : notes[0]?.id || null;
  const selectedNote = notes.find((note) => note.id === selectedId);
  const validFolders = new Set(["all", "recent", ...folders.map((folder) => folder.id)]);
  let activeFolder = validFolders.has(ui.activeFolder)
    ? ui.activeFolder
    : selectedNote?.folder || "all";
  if (selectedNote && activeFolder !== "all" && activeFolder !== "recent" && activeFolder !== selectedNote.folder) {
    activeFolder = selectedNote.folder;
  }
  if (selectedNote && activeFolder === "recent" && !isRecentNote(selectedNote)) {
    activeFolder = selectedNote.folder;
  }
  const mobileView = ["folders", "list", "editor"].includes(ui.mobileView)
    ? ui.mobileView
    : selectedId ? "editor" : "folders";

  return {
    notes,
    folders,
    activeFolder,
    selectedId,
    query: "",
    folderQuery: "",
    mobileView,
    previewMode: Boolean(ui.previewMode)
  };
}

function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(uiStorageKey)) || {};
  } catch {
    return {};
  }
}

function saveUiState() {
  localStorage.setItem(uiStorageKey, JSON.stringify({
    activeFolder: state.activeFolder,
    selectedId: state.selectedId,
    mobileView: state.mobileView,
    previewMode: state.previewMode
  }));
}

function render() {
  els.searchInput.value = state.query;
  renderFolders();
  renderListOnly();
  renderEditor();
  renderMobileChrome();
}

function renderFolders() {
  const now = Date.now();
  const recentCutoff = now - 1000 * 60 * 60 * 24 * 7;
  const allFolder = { id: "all", name: "所有笔记", icon: "▣", count: state.notes.length };
  const recentFolder = {
    id: "recent",
    name: "最近编辑",
    icon: "clock-3",
    count: state.notes.filter((note) => note.updatedAt >= recentCutoff).length
  };
  allFolder.icon = "file-text";
  const folderQuery = state.mobileView === "folders" ? state.folderQuery.trim().toLowerCase() : "";
  const userFolders = state.folders
    .filter((folder) => !folderQuery || folder.name.toLowerCase().includes(folderQuery))
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      icon: "folder",
      count: state.notes.filter((note) => note.folder === folder.id).length,
      deletable: folder.id !== "notes"
    }));

  const smartFolders = [allFolder, recentFolder].filter((folder) => (
    !folderQuery || folder.name.toLowerCase().includes(folderQuery)
  ));

  els.folderList.replaceChildren(...[...smartFolders, ...userFolders].map(renderFolderItem));
}

function renderListOnly() {
  const visible = getVisibleNotes();
  if (!visible.some((note) => note.id === state.selectedId)) {
    state.selectedId = visible[0]?.id || null;
  }

  const labels = {
    all: "所有笔记",
    recent: "最近编辑"
  };
  const activeFolder = state.folders.find((folder) => folder.id === state.activeFolder);

  els.listTitle.textContent = labels[state.activeFolder] || activeFolder?.name || "所有笔记";
  els.listCount.textContent = `${visible.length} 个笔记`;
  els.deleteNote.disabled = !state.selectedId;
  els.noteList.replaceChildren(...renderGroupedNotes(visible));
  renderFolders();
}

function renderGroupedNotes(notes) {
  const nodes = [];
  let currentGroup = "";

  notes.forEach((note) => {
    const group = formatSectionDate(note.updatedAt);
    if (group !== currentGroup) {
      currentGroup = group;
      const heading = document.createElement("div");
      heading.className = "note-section-title";
      heading.textContent = group;
      nodes.push(heading);
    }
    nodes.push(renderNoteButton(note));
  });

  return nodes;
}

function renderFolderItem(folder) {
  const item = document.createElement("div");
  item.className = `folder-item${folder.deletable ? " can-delete" : ""}`;

  const button = document.createElement("button");
  button.className = `folder-row${folder.id === state.activeFolder ? " active" : ""}`;
  button.type = "button";
  button.dataset.folder = folder.id;

  const icon = document.createElement("i");
  icon.className = "folder-icon";
  icon.dataset.lucide = folder.icon;
  icon.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.textContent = folder.name;

  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = folder.count;

  button.append(icon, name, count);
  button.addEventListener("click", () => {
    state.activeFolder = folder.id;
    const visible = getVisibleNotes();
    state.selectedId = visible[0]?.id || null;
    state.mobileView = "list";
    saveUiState();
    render();
  });

  item.append(button);

  if (folder.deletable) {
    const deleteButton = document.createElement("button");
    deleteButton.className = "folder-delete";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除${folder.name}`);
    deleteButton.title = "删除文件夹";
    deleteButton.innerHTML = '<i data-lucide="trash-2" aria-hidden="true"></i>';
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteFolder(folder.id);
    });
    item.append(deleteButton);
  }

  return item;
}

function renderNoteButton(note) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `note-card${note.id === state.selectedId ? " selected" : ""}`;
  button.dataset.noteId = note.id;
  button.setAttribute("aria-label", getTitle(note));

  const title = document.createElement("span");
  title.className = "note-title";
  title.textContent = getTitle(note);

  const preview = document.createElement("span");
  preview.className = "note-preview";
  preview.innerHTML = `<span class="note-date">${formatListDate(note.updatedAt)}</span> ${getPreview(note)}`;

  button.append(title, preview);
  button.addEventListener("click", () => {
    state.selectedId = note.id;
    state.mobileView = "editor";
    saveUiState();
    render();
    els.editor.focus();
  });

  return button;
}

function renderEditor() {
  const note = getSelectedNote();
  els.editorPane.classList.toggle("empty", !note);
  els.editor.disabled = !note;
  els.saveNote.disabled = !note;
  els.mobileSave.disabled = !note;
  els.editorPreviewToggle.disabled = !note;
  els.mobilePreviewToggle.disabled = !note;
  els.mobileMore.disabled = !note;
  els.mobileMenuSave.disabled = !note;
  els.mobileMenuPreview.disabled = !note;
  els.mobileMenuDelete.disabled = !note;
  els.previewToggle.classList.toggle("active", state.previewMode);
  els.editorPreviewToggle.classList.toggle("active", state.previewMode);
  els.mobilePreviewToggle.classList.toggle("active", state.previewMode);
  els.mobileMenuPreview.classList.toggle("active", state.previewMode);

  if (!note) {
    els.mobileActionMenu.hidden = true;
    els.editor.value = "";
    els.editor.hidden = false;
    els.editedAt.textContent = "";
    els.markdownPreview.hidden = true;
    els.noteFolderSelect.replaceChildren();
    els.mobileNoteFolderSelect.replaceChildren();
    els.noteFolderSelect.disabled = true;
    els.mobileNoteFolderSelect.disabled = true;
    return;
  }

  if (els.editor.value !== note.body) {
    els.editor.value = note.body;
  }
  els.editor.hidden = state.previewMode;
  els.markdownPreview.hidden = !state.previewMode;
  renderMarkdownPreview(note);
  renderNoteFolderSelect(note);
  updateEditorMeta(note);
}

function renderNoteFolderSelect(note) {
  const options = state.folders.map((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.name;
    option.selected = folder.id === note.folder;
    return option;
  });
  const mobileOptions = options.map((option) => option.cloneNode(true));
  els.noteFolderSelect.disabled = false;
  els.mobileNoteFolderSelect.disabled = false;
  els.noteFolderSelect.replaceChildren(...options);
  els.mobileNoteFolderSelect.replaceChildren(...mobileOptions);
}

function renderMobileChrome() {
  if (!["folders", "list", "editor"].includes(state.mobileView)) {
    state.mobileView = "folders";
  }

  els.appShell.dataset.mobileView = state.mobileView;
  const activeLabel = getActiveFolderLabel();
  const selected = getSelectedNote();

  if (state.mobileView === "folders") {
    els.mobileTitle.textContent = "文件夹";
    els.mobileBackLabel.textContent = "返回";
    els.mobileBack.classList.add("is-hidden");
    els.mobileSearchInput.value = state.folderQuery;
    els.mobileSearchInput.placeholder = "搜索文件夹";
  } else if (state.mobileView === "list") {
    els.mobileTitle.textContent = activeLabel;
    els.mobileBackLabel.textContent = "文件夹";
    els.mobileBack.classList.remove("is-hidden");
    els.mobileSearchInput.value = state.query;
    els.mobileSearchInput.placeholder = "搜索";
  } else {
    els.mobileTitle.textContent = selected ? getTitle(selected) : "笔记";
    els.mobileBackLabel.textContent = activeLabel;
    els.mobileBack.classList.remove("is-hidden");
    els.mobileSearchInput.value = state.query;
    els.mobileSearchInput.placeholder = "搜索";
  }
  if (state.mobileView !== "editor") {
    els.mobileActionMenu.hidden = true;
  }
  renderIcons();
}

function updateEditorMeta(note) {
  els.editedAt.dateTime = new Date(note.updatedAt).toISOString();
  els.editedAt.textContent = `编辑于 ${formatFullDate(note.updatedAt)}`;
}

function getVisibleNotes() {
  const query = state.query.trim().toLowerCase();

  return state.notes
    .filter((note) => {
      if (state.activeFolder === "recent") return isRecentNote(note);
      if (state.activeFolder !== "all") return note.folder === state.activeFolder;
      return true;
    })
    .filter((note) => {
      if (!query) return true;
      return `${getTitle(note)} ${note.body}`.toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function isRecentNote(note) {
  return note.updatedAt >= Date.now() - 1000 * 60 * 60 * 24 * 7;
}

function getSelectedNote() {
  return state.notes.find((note) => note.id === state.selectedId) || null;
}

async function deleteFolder(folderId) {
  const folder = state.folders.find((entry) => entry.id === folderId);
  if (!folder || folder.id === "notes") return;

  const shouldDelete = window.confirm(`删除“${folder.name}”？其中的笔记会移到“备忘录”。`);
  if (!shouldDelete) return;

  const fallbackFolder = state.folders.find((entry) => entry.id === "notes") || state.folders[0];
  state.notes.forEach((note) => {
    if (note.folder === folder.id) {
      note.folder = fallbackFolder.id;
      note.updatedAt = Date.now();
    }
  });

  state.folders = state.folders.filter((entry) => entry.id !== folder.id);
  if (state.activeFolder === folder.id) {
    state.activeFolder = fallbackFolder.id;
    const visible = getVisibleNotes();
    state.selectedId = visible[0]?.id || null;
    state.mobileView = "list";
  }

  render();

  try {
    await removeFolder(folder.id);
    setSaveStatus("文件夹已删除", "ok");
    const fresh = await loadState();
    Object.assign(state, fresh);
    render();
  } catch (error) {
    setSaveStatus("删除失败", "error");
    console.error("Failed to delete folder.", error);
    const fresh = await loadState();
    Object.assign(state, fresh);
    render();
  }
}

function getActiveFolderLabel() {
  if (state.activeFolder === "all") return "所有笔记";
  if (state.activeFolder === "recent") return "最近编辑";
  return state.folders.find((folder) => folder.id === state.activeFolder)?.name || "笔记";
}

function getWriteFolderId() {
  if (state.folders.some((folder) => folder.id === state.activeFolder)) {
    return state.activeFolder;
  }
  return state.folders[0]?.id || "notes";
}

function getUniqueFolderName(baseName) {
  const existing = new Set(state.folders.map((folder) => folder.name));
  if (!existing.has(baseName)) return baseName;

  let index = 2;
  while (existing.has(`${baseName} ${index}`)) {
    index += 1;
  }
  return `${baseName} ${index}`;
}

function defaultFolders() {
  return [{ id: "notes", name: "备忘录", version: 1 }];
}

function renderIcons() {
  window.lucide?.createIcons({
    attrs: {
      "stroke-width": 2
    }
  });
}

function renderMarkdownPreview(note) {
  if (!state.previewMode) return;
  els.markdownPreview.innerHTML = markdownToHtml(note.body);
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let listType = "";
  let inCode = false;
  let codeLines = [];

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      return;
    }

    if (inCode) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      return;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      return;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      return;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      return;
    }

    if (trimmed.startsWith(">")) {
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.slice(1).trim())}</blockquote>`);
      return;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  });

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  closeList();
  return html.join("");
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getTitle(note) {
  const firstLine = note.body.split(/\n/).find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : "新建笔记";
}

function getPreview(note) {
  const lines = note.body.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const text = lines.slice(1).join(" ") || "无附加文本";
  return text.slice(0, 140);
}

function formatListDate(value) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function formatFullDate(value) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatSectionDate(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";

  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString("zh-CN", sameYear
    ? { month: "long", day: "numeric" }
    : { year: "numeric", month: "long", day: "numeric" });
}
