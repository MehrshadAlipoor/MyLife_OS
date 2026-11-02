/**
 * GitHub as file storage for the Obsidian vault and the D1 backups: read one file or folder, and
 * write several files as ONE commit (ref → base tree → new tree with inline content → commit →
 * move ref). Unlike phd-applications' loadSnapshot it never downloads the whole repo tree.
 * The gh() helper is ported from phd-applications/scripts/lib/github-store.mjs.
 */

import { Buffer } from 'node:buffer';
import type { Env } from './env';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function gh<T>(env: Env, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!env.GITHUB_TOKEN) throw new GitHubError(401, 'GITHUB_TOKEN is not set');
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    // GitHub lets caches keep API GETs for 60 s; a stale ref would make the next commit a non-fast-forward.
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // Workers send no User-Agent by default and GitHub answers 403 without one.
      'User-Agent': 'life-os-bot',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* ignore */
    }
    throw new GitHubError(res.status, `GitHub ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Only these paths can be read: Markdown notes and folders, no traversal. */
export function safeVaultPath(path: string): string | null {
  const clean = path.trim().replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some(seg => seg === '..' || seg === '.' || seg.startsWith('.'))) return null;
  if (clean && /\.[a-z0-9]+$/i.test(clean) && !/\.md$/i.test(clean)) return null;
  return clean;
}

export type RepoEntry = { name: string; path: string; type: 'file' | 'dir' };

/** A file's text (null if missing), or a folder listing. */
export async function readPath(env: Env, repo: string, branch: string, path: string): Promise<{ file: string } | { dir: RepoEntry[] } | null> {
  try {
    const data = await gh<unknown>(env, `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (Array.isArray(data)) {
      return { dir: data.map((e: { name: string; path: string; type: string }) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file' })) };
    }
    const file = data as { content?: string; encoding?: string };
    if (file.encoding !== 'base64' || file.content == null) throw new GitHubError(415, 'file is too large to read through the API');
    return { file: Buffer.from(file.content, 'base64').toString('utf8') };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export interface FileWrite { path: string; content: string }

/**
 * Commit `files` to `branch` as one commit. If the branch doesn't exist and `orphanIfMissing` is set,
 * it is created with a root commit (used for the backups branch). Retries once on a race.
 */
export async function commitFiles(env: Env, repo: string, branch: string, message: string, files: FileWrite[], orphanIfMissing = false): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      let parent: string | null = null;
      let baseTree: string | undefined;
      try {
        const ref = await gh<{ object: { sha: string } }>(env, `/repos/${repo}/git/ref/heads/${encodePath(branch)}`);
        parent = ref.object.sha;
        baseTree = (await gh<{ tree: { sha: string } }>(env, `/repos/${repo}/git/commits/${parent}`)).tree.sha;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 404 && orphanIfMissing)) throw e;
      }
      const tree = await gh<{ sha: string }>(env, `/repos/${repo}/git/trees`, {
        method: 'POST',
        body: { ...(baseTree ? { base_tree: baseTree } : {}), tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }
      });
      const commit = await gh<{ sha: string }>(env, `/repos/${repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: parent ? [parent] : [] }
      });
      if (parent) await gh(env, `/repos/${repo}/git/refs/heads/${encodePath(branch)}`, { method: 'PATCH', body: { sha: commit.sha } });
      else await gh(env, `/repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      return commit.sha;
    } catch (e) {
      // 422: someone (Obsidian Git) pushed between our read and our ref update.
      if (attempt === 0 && e instanceof GitHubError && e.status === 422) continue;
      throw e;
    }
  }
}

/** Generated files carry this frontmatter flag; anything without it is the user's and is never overwritten. */
export const GENERATED_MARK = 'generated: life-os';

export function isGenerated(text: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return !!frontmatter && /^generated: life-os[ \t]*\r?$/m.test(frontmatter[1] ?? '');
}
