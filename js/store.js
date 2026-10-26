// Storage layer: keeps contracts in a private GitHub repository through the
// GitHub REST API. contracts.json holds the facts; files/ holds the originals.

(function () {
  'use strict';

  const CFG_KEY = 'tmc.config';
  const INDEX_PATH = 'contracts.json';

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* storage blocked */ }
  }
  function clearConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch { /* storage blocked */ }
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function b64ToText(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // Turns a failed GitHub response into a message that says what to do about it.
  async function ghError(res, what) {
    let msg = '';
    try { msg = (await res.clone().json()).message || ''; } catch { /* not JSON */ }
    if (res.status === 401) return new Error(`${what}: GitHub rejected the access token. It may have expired; create a new one and reconnect in Settings.`);
    if (res.status === 403 && /rate limit/i.test(msg)) return new Error(`${what}: GitHub's rate limit was hit. Wait a few minutes and try again.`);
    if (res.status === 403) return new Error(`${what}: the access token is not allowed to write to this repository. On GitHub, edit the token and set Repository permissions → Contents to "Read and write" (with tmc-contracts-data selected), then try again.`);
    return new Error(`${what} (GitHub ${res.status}${msg ? ': ' + msg : ''})`);
  }

  class GitHubStore {
    constructor(cfg) {
      this.cfg = cfg;
      this.sha = null;
    }

    url(path) {
      const { owner, repo } = this.cfg;
      return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    }

    async req(method, path, body, accept) {
      const res = await fetch(this.url(path) + (method === 'GET' ? `?ref=${encodeURIComponent(this.cfg.branch)}&t=${Date.now()}` : ''), {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: accept || 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      return res;
    }

    async check() {
      const { owner, repo } = this.cfg;
      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 401) throw new Error('GitHub rejected the access token. Check that it was copied fully and has not expired.');
      if (res.status === 404) throw new Error(`Repository ${owner}/${repo} was not found, or the token cannot see it.`);
      if (!res.ok) throw new Error(`GitHub error ${res.status}`);
      const info = await res.json();
      if (info.permissions && !info.permissions.push) throw new Error('The token can read but not write to this repository. Give it "Contents: Read and write".');
      if (!this.cfg.branch) this.cfg.branch = info.default_branch || 'main';
      return info;
    }

    async loadIndex() {
      const res = await this.req('GET', INDEX_PATH);
      if (res.status === 404) { this.sha = null; return { version: 1, contracts: [] }; }
      if (!res.ok) throw await ghError(res, 'Could not load contracts');
      const meta = await res.json();
      this.sha = meta.sha;
      let text;
      if (meta.content) text = b64ToText(meta.content);
      else {
        const raw = await this.req('GET', INDEX_PATH, null, 'application/vnd.github.raw');
        text = await raw.text();
      }
      const data = JSON.parse(text || '{}');
      data.contracts = data.contracts || [];
      return data;
    }

    async writeIndex(data, message) {
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
      const res = await this.req('PUT', INDEX_PATH, {
        message, content: bytesToB64(bytes), branch: this.cfg.branch, ...(this.sha ? { sha: this.sha } : {}),
      });
      if (res.status === 409 || res.status === 422) return false; // someone else saved first
      if (!res.ok) throw await ghError(res, 'Could not save');
      this.sha = (await res.json()).content.sha;
      return true;
    }

    // Load the newest index, apply the change, save; retry if another device saved in between.
    async mutate(fn, message) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const data = await this.loadIndex();
        fn(data);
        if (await this.writeIndex(data, message)) return data;
      }
      throw new Error('Could not save because the data kept changing. Please try again.');
    }

    async uploadFile(path, file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await this.req('PUT', path, { message: `Upload ${file.name}`, content: bytesToB64(bytes), branch: this.cfg.branch });
      if (!res.ok) {
        if (res.status === 413 || res.status === 422) throw new Error(`Could not upload the file (GitHub ${res.status}). The file may be too large (keep it under ~50 MB).`);
        throw await ghError(res, 'Could not upload the file');
      }
    }

    async downloadFile(path) {
      const res = await this.req('GET', path, null, 'application/vnd.github.raw');
      if (!res.ok) throw await ghError(res, 'Could not download the file');
      return await res.blob();
    }

    async deleteFile(path) {
      const meta = await this.req('GET', path);
      if (!meta.ok) return;
      const { sha } = await meta.json();
      await this.req('DELETE', path, { message: `Delete ${path}`, sha, branch: this.cfg.branch });
    }
  }

  window.ContractStore = { GitHubStore, loadConfig, saveConfig, clearConfig };
})();
