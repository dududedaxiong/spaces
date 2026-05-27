import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 7860);
const appOrigin = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:4173");
let backupRunning = false;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/backup-injected.js") {
      sendText(res, 200, injectedScript(), "text/javascript; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/backup/run") {
      await handleBackup(req, res);
      return;
    }

    await proxyRequest(req, res, url);
  } catch (error) {
    console.error("[backup-proxy]", error);
    sendJson(res, 500, { ok: false, error: "proxy_error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Backup proxy running at http://0.0.0.0:${port}`);
  console.log(`Proxying app origin: ${appOrigin.origin}`);
});

async function handleBackup(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (!isSameOriginRequest(req)) {
    sendJson(res, 403, { ok: false, error: "origin_forbidden" });
    return;
  }
  if (!await isAuthenticated(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (backupRunning) {
    sendJson(res, 409, { ok: false, error: "backup_running" });
    return;
  }

  backupRunning = true;
  try {
    const result = await runBackupScript();
    sendJson(res, 200, result);
  } catch (error) {
    console.error("[backup]", error);
    sendJson(res, 500, { ok: false, error: "backup_failed" });
  } finally {
    backupRunning = false;
  }
}

async function isAuthenticated(req) {
  const response = await fetch(new URL("/api/auth/status", appOrigin), {
    headers: {
      cookie: req.headers.cookie || ""
    }
  });
  if (!response.ok) return false;
  const status = await response.json().catch(() => ({}));
  return status.authenticated === true;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function runBackupScript() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/backup-sqlite.mjs", "--backup"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`backup_script_failed_${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(parseLastJson(stdout));
    });
  });
}

async function proxyRequest(req, res, url) {
  const target = new URL(`${url.pathname}${url.search}`, appOrigin);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    init.body = await readBody(req);
  }

  const response = await fetch(target, init);
  const responseHeaders = new Headers(response.headers);
  let body = Buffer.from(await response.arrayBuffer());

  if (isHtmlResponse(responseHeaders)) {
    const html = body.toString("utf8");
    body = Buffer.from(injectBackupScript(html));
    responseHeaders.set("content-length", String(body.byteLength));
  }

  res.writeHead(response.status, Object.fromEntries(responseHeaders.entries()));
  res.end(body);
}

function injectBackupScript(html) {
  if (html.includes("/backup-injected.js")) return html;
  const tag = '<script src="/backup-injected.js" defer></script>';
  return html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : `${html}${tag}`;
}

function injectedScript() {
  return `
(() => {
  const uploadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 8 5-5 5 5"></path><path d="M5 21h14"></path></svg>';

  function makeButton(className, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', '备份数据库');
    button.title = '备份数据库';
    button.innerHTML = label ? uploadIcon + '<span>' + label + '</span>' : uploadIcon;
    button.addEventListener('click', runBackup);
    return button;
  }

  async function runBackup(event) {
    const button = event.currentTarget;
    button.disabled = true;
    const originalOpacity = button.style.opacity;
    button.style.opacity = '0.45';
    try {
      const response = await fetch('/api/backup/run', { method: 'POST' });
      if (response.status === 401) {
        alert('请先登录后再备份');
        return;
      }
      if (response.status === 409) {
        alert('备份正在进行中');
        return;
      }
      if (!response.ok) throw new Error('backup_failed');
      alert('备份完成');
    } catch {
      alert('备份失败，请检查 rclone 配置');
    } finally {
      button.disabled = false;
      button.style.opacity = originalOpacity;
    }
  }

  function mount() {
    if (!document.querySelector('[data-backup-button="desktop"]')) {
      const toolbar = document.querySelector('.toolbar');
      if (toolbar) {
        const button = makeButton('icon-button', '');
        button.dataset.backupButton = 'desktop';
        toolbar.append(button);
      }
    }

    if (!document.querySelector('[data-backup-button="mobile"]')) {
      const menu = document.querySelector('#mobileActionMenu');
      if (menu) {
        const button = makeButton('', '备份');
        button.dataset.backupButton = 'mobile';
        menu.append(button);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
`;
}

function isHtmlResponse(headers) {
  return (headers.get("content-type") || "").includes("text/html");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return { ok: true };
  try {
    return JSON.parse(last);
  } catch {
    return { ok: true };
  }
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
