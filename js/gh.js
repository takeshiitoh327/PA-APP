// Minimal GitHub Contents API client. The token never leaves the browser
// except in requests to api.github.com.

const API = "https://api.github.com";
const KEY = "pa-app.settings";

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { owner: "takeshiitoh327", repo: "personal-assistant", branch: "main", token: "", ...s };
  } catch {
    return { owner: "takeshiitoh327", repo: "personal-assistant", branch: "main", token: "" };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function clearSettings() {
  localStorage.removeItem(KEY);
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class Repo {
  constructor({ owner, repo, branch, token }) {
    Object.assign(this, { owner, repo, branch, token });
  }

  async request(method, path, body) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (await res.json()).message || message;
      } catch {}
      throw new GitHubError(res.status, message);
    }
    return res.json();
  }

  async check() {
    const info = await this.request("GET", "");
    if (!info) throw new GitHubError(404, "Repository not found, or the token has no access to it");
    return info;
  }

  // Returns { text, sha } or null when the file does not exist.
  async getFile(path) {
    const data = await this.request("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`);
    if (!data) return null;
    return { text: decodeBase64(data.content), sha: data.sha };
  }

  async listDir(path) {
    const data = await this.request("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`);
    return Array.isArray(data) ? data : [];
  }

  async putFile(path, text, sha, message) {
    return this.request("PUT", `/contents/${encodePath(path)}`, {
      message,
      content: encodeBase64(text),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    });
  }

  // Read-modify-write with one retry when someone else pushed in between.
  async updateFile(path, transform, message) {
    for (let attempt = 0; ; attempt++) {
      const current = await this.getFile(path);
      const next = transform(current ? current.text : null);
      if (current && next === current.text) return;
      try {
        await this.putFile(path, next, current && current.sha, message);
        return;
      } catch (e) {
        if (attempt === 0 && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
  }
}
