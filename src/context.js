const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

/** @typedef {{ tokens: number, model?: string, at: Date }} ContextReading */

const TAIL_BYTES = 512 * 1024

function projectsDir() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(dir, 'projects')
}

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes '-'. */
function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

async function newestJsonl(dir) {
  let best
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return undefined
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    try {
      const { mtimeMs } = await fs.stat(file)
      if (!best || mtimeMs > best.mtime) best = { file, mtime: mtimeMs }
    } catch { }
  }
  return best
}

/**
 * The transcript most recently written: in this workspace's project folders if any, else anywhere.
 * @returns {Promise<{ file: string, mtime: number } | undefined>}
 */
async function latestTranscript(workspaces) {
  const root = projectsDir()
  const keys = new Set(workspaces.map((w) => projectKey(w).toLowerCase()))
  let dirs
  try {
    dirs = await fs.readdir(root)
  } catch {
    return undefined
  }
  const pick = async (names) => {
    let best
    for (const d of names) {
      const f = await newestJsonl(path.join(root, d))
      if (f && (!best || f.mtime > best.mtime)) best = f
    }
    return best
  }
  const own = dirs.filter((d) => keys.has(d.toLowerCase()))
  return (own.length > 0 ? await pick(own) : undefined) ?? (await pick(dirs))
}

/** Context size of the main loop's last request: input + cache read + cache creation. @returns {ContextReading | undefined} */
function lastContext(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue
    try {
      const j = JSON.parse(line)
      if (j.type !== 'assistant' || j.isSidechain) continue
      const u = j.message?.usage
      if (!u) continue
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (tokens === 0) continue
      return { tokens, model: j.message?.model, at: new Date(j.timestamp ?? Date.now()) }
    } catch { }
  }
  return undefined
}

/** @returns {Promise<ContextReading | undefined>} */
async function readContext(file) {
  try {
    const handle = await fs.open(file, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      return lastContext(buf.toString('utf-8'))
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

module.exports = { projectKey, latestTranscript, lastContext, readContext }
