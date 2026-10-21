const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * @typedef {{ ok: true, body: unknown }
 *   | { ok: false, reason: 'no-credentials' | 'expired' | 'rate-limited' | 'http' | 'network', detail?: string, retryAfter?: number }} UsageResult
 */

/** Wait at least this long after a 429 when the server names no Retry-After. */
const COOLDOWN_MS = 5 * 60_000

function credentialsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(dir, '.credentials.json')
}

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )
}

/** Claude Code's own OAuth credentials: the file, or on macOS the Keychain. Read only; never refreshed here. */
async function readCredentials() {
  try {
    return JSON.parse(await fs.readFile(credentialsPath(), 'utf-8'))
  } catch { }
  if (process.platform === 'darwin') {
    try {
      return JSON.parse(await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']))
    } catch { }
  }
  return null
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': 'oauth-2025-04-20',
  'Content-Type': 'application/json',
})

async function viaFetch(token) {
  const r = await fetch(USAGE_URL, { headers: headers(token), signal: AbortSignal.timeout(15_000) })
  return { status: r.status, body: await r.text(), retryAfter: Number(r.headers.get('retry-after')) || undefined }
}

/** Anthropic sometimes rejects Node's TLS fingerprint with 403 "Request not allowed"; curl gets through. */
async function viaCurl(token) {
  const args = ['-s', '-w', '\n%{http_code}', USAGE_URL]
  for (const [k, v] of Object.entries(headers(token))) args.push('-H', `${k}: ${v}`)
  const out = await run('curl', args)
  const i = out.lastIndexOf('\n')
  return { status: Number(out.slice(i + 1)), body: out.slice(0, i) }
}

let preferCurl = false

/** @returns {Promise<UsageResult>} */
async function fetchUsage() {
  const creds = await readCredentials()
  const oauth = creds?.claudeAiOauth
  if (!oauth?.accessToken) return { ok: false, reason: 'no-credentials' }
  // Claude Code refreshes the token itself while it runs.
  if (oauth.expiresAt && Date.now() >= oauth.expiresAt) return { ok: false, reason: 'expired' }

  let r
  try {
    r = preferCurl ? await viaCurl(oauth.accessToken) : await viaFetch(oauth.accessToken)
    if (!preferCurl && r.status === 403 && r.body.includes('Request not allowed')) {
      preferCurl = true
      r = await viaCurl(oauth.accessToken)
    }
  } catch (e) {
    if (preferCurl) return { ok: false, reason: 'network', detail: e.message }
    try {
      preferCurl = true
      r = await viaCurl(oauth.accessToken)
    } catch (e2) {
      return { ok: false, reason: 'network', detail: e2.message }
    }
  }
  if (r.status === 429) return { ok: false, reason: 'rate-limited', retryAfter: r.retryAfter }
  if (r.status === 401) return { ok: false, reason: 'expired' }
  if (r.status !== 200) return { ok: false, reason: 'http', detail: `${r.status} ${r.body.slice(0, 200)}` }
  try {
    return { ok: true, body: JSON.parse(r.body) }
  } catch {
    return { ok: false, reason: 'http', detail: 'bad JSON' }
  }
}

/**
 * Usage through a cache file every VS Code window shares, so windows and reloads do not each
 * hit the API: a reading younger than maxAgeMs is reused, and after a 429 nobody asks again
 * until the cooldown ends. The last good body comes back with any error.
 * @returns {Promise<{ body?: unknown, fetchedAt?: number, error?: UsageResult }>}
 */
async function cachedUsage(cacheFile, maxAgeMs, force = false) {
  let cache = {}
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8'))
  } catch { }
  const now = Date.now()
  if (cache.cooldownUntil && now < cache.cooldownUntil) {
    return { body: cache.body, fetchedAt: cache.fetchedAt, error: { ok: false, reason: 'rate-limited' } }
  }
  if (!force && cache.body && cache.fetchedAt && now - cache.fetchedAt < maxAgeMs) {
    return { body: cache.body, fetchedAt: cache.fetchedAt }
  }

  const r = await fetchUsage()
  if (r.ok) cache = { body: r.body, fetchedAt: now }
  else if (r.reason === 'rate-limited') cache.cooldownUntil = now + Math.max(COOLDOWN_MS, (r.retryAfter ?? 0) * 1000)
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true })
    await fs.writeFile(cacheFile, JSON.stringify(cache))
  } catch { }
  return { body: cache.body, fetchedAt: cache.fetchedAt, error: r.ok ? undefined : r }
}

module.exports = { fetchUsage, cachedUsage }
