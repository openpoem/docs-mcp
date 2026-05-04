/**
 * GitHub API client for docs-mcp.
 *
 * Uses Node 20+ global fetch and the GitHub REST API directly — no SDK dependency.
 */

const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'docs-mcp/2.0.0'

function getRepoTarget(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  if (owner && repo) return { owner, repo }

  const combined = process.env.GITHUB_REPOSITORY
  if (combined && combined.includes('/')) {
    const [o, r] = combined.split('/')
    if (o && r) return { owner: o, repo: r }
  }

  throw new Error(
    'Repository target is not configured. Set GITHUB_OWNER + GITHUB_REPO, ' +
    'or GITHUB_REPOSITORY=owner/repo.'
  )
}

function getToken(): string {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')
  return token
}

function getDefaultBranch(): string {
  return process.env.GITHUB_DEFAULT_BRANCH || 'main'
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function ghFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = path.startsWith('https://') ? path : `${GITHUB_API}${path}`
  const res = await fetch(url, { ...options, headers: { ...headers(), ...options?.headers } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`)
  }
  return res
}

function repoPath(): string {
  const { owner, repo } = getRepoTarget()
  return `/repos/${owner}/${repo}`
}

export interface ContentEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  sha: string
  size: number
  html_url: string
}

export interface FileContent {
  content: string
  sha: string
  size: number
  path: string
}

export interface CommitResult {
  sha: string
  url: string
}

export interface PullRequestResult {
  number: number
  html_url: string
  state: string
}

export { getDefaultBranch, getRepoTarget }

export async function listContents(path: string): Promise<ContentEntry[]> {
  const res = await ghFetch(`${repoPath()}/contents/${encodeURI(path)}`)
  const data = await res.json()
  return Array.isArray(data) ? data : [data]
}

export async function readFile(path: string, ref?: string): Promise<FileContent> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await ghFetch(`${repoPath()}/contents/${encodeURI(path)}${qs}`)
  const data = await res.json()

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`)
  }

  const raw = (data.content as string).replace(/\n/g, '')
  const content = Buffer.from(raw, 'base64').toString('utf-8')

  return { content, sha: data.sha, size: data.size, path: data.path }
}

export async function createOrUpdateFile(opts: {
  path: string
  message: string
  content: string
  branch: string
  sha?: string
}): Promise<CommitResult> {
  const encoded = Buffer.from(opts.content, 'utf-8').toString('base64')

  const body: Record<string, unknown> = {
    message: opts.message,
    content: encoded,
    branch: opts.branch,
  }
  if (opts.sha) body.sha = opts.sha

  const res = await ghFetch(`${repoPath()}/contents/${encodeURI(opts.path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  const data = await res.json()

  return {
    sha: data.commit?.sha ?? '',
    url: data.commit?.html_url ?? '',
  }
}

export async function createBranch(name: string, fromBranch?: string): Promise<string> {
  const base = fromBranch ?? getDefaultBranch()
  const refRes = await ghFetch(`${repoPath()}/git/ref/heads/${encodeURIComponent(base)}`)
  const refData = await refRes.json()
  const sha = refData.object.sha

  await ghFetch(`${repoPath()}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${name}`,
      sha,
    }),
  })

  return name
}

export async function createPullRequest(opts: {
  title: string
  head: string
  base?: string
  body?: string
  labels?: string[]
}): Promise<PullRequestResult> {
  const res = await ghFetch(`${repoPath()}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: opts.title,
      head: opts.head,
      base: opts.base ?? getDefaultBranch(),
      body: opts.body ?? '',
    }),
  })
  const data = await res.json()

  if (opts.labels && opts.labels.length > 0) {
    await ghFetch(`${repoPath()}/issues/${data.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: opts.labels }),
    }).catch(() => {
      // Non-critical: label may not exist
    })
  }

  return {
    number: data.number,
    html_url: data.html_url,
    state: data.state,
  }
}

export async function getFileSha(path: string, ref?: string): Promise<string | null> {
  try {
    const file = await readFile(path, ref)
    return file.sha
  } catch {
    return null
  }
}
