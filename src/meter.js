// Pure display logic, ported from bar-claude-meter's hooks/meter.ts.

/** @typedef {{ kind: string, percentUsed: number, resetsAt?: string }} RateLimit */
/** @typedef {{ top: boolean, bottom: boolean }} Cell  top = quota bar reaches it, bottom = time bar */
/** @typedef {{ kind: string, label: string, cells: Cell[], percentUsed: number, percentLeft: number, timeLeft?: string, resetsAt?: Date }} Meter */

const ORDER = ['five_hour', 'seven_day']

const WINDOW_MS = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
}

function labelFor(kind) {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind
}

/** @param {RateLimit[]} limits */
function sortLimits(limits) {
  const rank = (kind) => {
    const i = ORDER.indexOf(kind)
    return i === -1 ? ORDER.length : i
  }
  return [...limits].sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** Milliseconds until reset, or undefined. */
function msLeft(resetsAt, now) {
  if (!resetsAt) return undefined
  const t = new Date(resetsAt).getTime()
  if (Number.isNaN(t)) return undefined
  return Math.max(0, t - now.getTime())
}

/** "2h05m", "3d4h", "45m". */
function formatLeft(ms) {
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

/** Top = quota left, bottom = time left, each a fraction of the window. @returns {Cell[]} */
function barCells(quotaLeft, timeLeft, width) {
  const cells = (f) => Math.round(Math.min(1, Math.max(0, f)) * width)
  const top = cells(quotaLeft)
  const bottom = timeLeft === undefined ? -1 : cells(timeLeft)
  return Array.from({ length: width }, (_, i) => ({ top: i < top, bottom: i < bottom }))
}

/**
 * Two bars stacked in one row with half blocks, in a single color:
 * █ both, ▀ quota only, ▄ time only. U+2800 (blank braille) keeps empty cells as wide as a block.
 */
function glyph(c) {
  return c.top && c.bottom ? '█' : c.top ? '▀' : c.bottom ? '▄' : '⠀'
}

/** @param {RateLimit[]} limits @returns {Meter[]} */
function meters(limits, now, width) {
  return sortLimits(limits).flatMap((limit) => {
    const window = WINDOW_MS[limit.kind]
    if (!window) return []
    const left = Math.max(0, 100 - limit.percentUsed)
    const ms = msLeft(limit.resetsAt, now)
    return [
      {
        kind: limit.kind,
        label: labelFor(limit.kind),
        cells: barCells(left / 100, ms === undefined ? undefined : ms / window, width),
        percentUsed: Math.round(limit.percentUsed),
        percentLeft: Math.round(left),
        timeLeft: ms === undefined ? undefined : formatLeft(ms),
        resetsAt: limit.resetsAt ? new Date(limit.resetsAt) : undefined,
      },
    ]
  })
}

/**
 * "5h██▀▀▀ ▏" (+ "62% 2h05m" with numbers). No left edge: ▕ draws at the right of its cell,
 * so it would leave a gap after the label. @param {Meter} m
 */
function meterText(m, showNumbers) {
  const bar = `${m.cells.map(glyph).join('')}▏`
  if (!showNumbers) return `${m.label}${bar}`
  return `${m.label}${bar}${m.percentLeft}%${m.timeLeft ? ` ${m.timeLeft}` : ''}`
}

/** "850", "12k", "1.2M". */
function formatTokens(n) {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Model's window: 1M for a "[1m]" model, Fable and Opus/Sonnet 4.6+ or 5+; 200K otherwise. */
function modelWindow(model = '') {
  const m = model.toLowerCase()
  if (/\[1m\]|fable/.test(m)) return 1_000_000
  if (/(?:opus|sonnet)-4-(?:[6-9]|\d\d)\b/.test(m) || /(?:opus|sonnet)-(?:[5-9]|\d\d)(?:-|\b)/.test(m)) return 1_000_000
  return 200_000
}

/** Context window to measure against: the model's, or 1M once usage passes it. */
function contextWindowFor(tokens, model) {
  const window = modelWindow(model)
  return tokens > window ? Math.max(window, 1_000_000) : window
}

/** "C38%": context used. */
function contextText(tokens, window) {
  return `C${Math.round((tokens / window) * 100)}%`
}

/** The same two-tone bar as the terminal plugin, as an SVG for the hover. @param {Meter} m */
function meterSvg(m, quotaColor, timeColor) {
  const cell = 12
  const w = m.cells.length * cell
  const rects = m.cells
    .map((c, i) => {
      const x = i * cell
      return (
        `<rect x="${x}" y="0" width="${cell - 1}" height="6" fill="${c.top ? quotaColor : '#8884'}"/>` +
        `<rect x="${x}" y="6" width="${cell - 1}" height="6" fill="${c.bottom ? timeColor : '#8882'}"/>`
      )
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="12">${rects}</svg>`
}

/** API response shape → RateLimit list. utilization is a percent (0–100). @returns {RateLimit[]} */
function limitsFromUsage(body) {
  if (!body || typeof body !== 'object') return []
  const out = []
  for (const kind of ORDER) {
    const w = body[kind]
    if (!w || typeof w.utilization !== 'number') continue
    out.push({ kind, percentUsed: w.utilization, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined })
  }
  return out
}

module.exports = {
  labelFor, sortLimits, msLeft, formatLeft, barCells, glyph, meters, meterText,
  formatTokens, contextWindowFor, contextText, meterSvg, limitsFromUsage,
}
