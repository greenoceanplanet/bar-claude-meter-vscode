const path = require('node:path')
const vscode = require('vscode')
const { latestTranscript, readContext } = require('./context')
const { contextText, contextWindowFor, formatTokens, limitsFromUsage, meters, meterSvg, meterText } = require('./meter')
const { cachedUsage } = require('./usage')

const QUOTA_COLOR = '#db724f'
const TIME_COLOR = '#888888'
const CTX_COLOR = '#5E9E6B'
const CTX_WARN_COLOR = '#D9534F'
/** How often to look at the latest transcript (context size, and whether Claude is working). */
const TRANSCRIPT_POLL_MS = 5_000
/** A transcript quiet this long after writes means the turn ended. */
const TURN_IDLE_MS = 15_000
/** Readings younger than this are reused, so windows and back-to-back triggers share one request. */
const MIN_FETCH_GAP_MS = 30_000
/** Reset time in the hover, weekday included: "10. 24. (토) 오후 09:00". */
const RESET_FORMAT = { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }
/** % used from which the item gets the warning / error background. */
const WARN_AT = 80
const ERROR_AT = 90

const REASONS = {
  'no-credentials': 'Claude Code 로그인 정보를 찾지 못함 (~/.claude/.credentials.json)',
  expired: '토큰 만료 — Claude Code를 한 번 실행하면 갱신됨',
  'rate-limited': '요청이 많아 잠시 대기 중 (429)',
  http: 'API 오류',
  network: '네트워크 오류',
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  /** @type {Map<string, vscode.StatusBarItem>} */
  const items = new Map()
  let limits = []
  let fetchedAt
  let lastError
  let ctx
  /** Last seen transcript write, and whether a turn looks under way. */
  let lastMtime
  let lastChangeAt = 0
  let working = false

  const config = () => vscode.workspace.getConfiguration('barClaudeMeter')

  function renderContext() {
    if (!config().get('showContext', true) || !ctx) {
      items.get('context')?.hide()
      return
    }
    const window = contextWindowFor(ctx.tokens, config().get('contextWindow', 200_000))
    const percent = Math.round((ctx.tokens / window) * 100)
    const item = itemFor('context', 10)
    item.text = contextText(ctx.tokens, window)
    item.color = percent >= 80 ? CTX_WARN_COLOR : CTX_COLOR
    item.tooltip = `컨텍스트 ${formatTokens(ctx.tokens)} / ${formatTokens(window)} (${percent}%)${ctx.model ? ` · ${ctx.model}` : ''}\n최근 Claude Code 세션 기준 · ${ctx.at.toLocaleTimeString()}`
    item.show()
  }

  /**
   * Usage is fetched when a turn starts (the transcript starts changing) and when it ends
   * (quiet for TURN_IDLE_MS), not on a timer. The context reading rides along.
   */
  async function watchTranscript() {
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []
    const t = await latestTranscript(folders)
    if (!t) return
    const now = Date.now()
    if (t.mtime !== lastMtime) {
      const first = lastMtime === undefined
      lastMtime = t.mtime
      lastChangeAt = now
      const next = await readContext(t.file)
      if (next?.tokens !== ctx?.tokens || next?.at.getTime() !== ctx?.at.getTime()) {
        ctx = next
        render()
      }
      if (!first && !working) {
        working = true
        void refresh()
      }
    } else if (working && now - lastChangeAt >= TURN_IDLE_MS) {
      working = false
      void refresh()
    }
  }

  function itemFor(kind, index) {
    let item = items.get(kind)
    if (!item) {
      // Right side: higher priority sits further left, so 5h comes before 7d.
      item = vscode.window.createStatusBarItem(`barClaudeMeter.${kind}`, vscode.StatusBarAlignment.Right, 1000 - index)
      item.name = `Claude ${kind}`
      item.command = 'barClaudeMeter.refresh'
      items.set(kind, item)
      context.subscriptions.push(item)
    }
    return item
  }

  function tooltip(list) {
    const md = new vscode.MarkdownString()
    md.supportHtml = true
    md.appendMarkdown('**Claude usage**\n\n')
    for (const m of list) {
      const svg = Buffer.from(meterSvg(m, QUOTA_COLOR, TIME_COLOR)).toString('base64')
      const reset = m.resetsAt ? ` · 리셋 ${m.resetsAt.toLocaleString(vscode.env.language, RESET_FORMAT)}` : ''
      md.appendMarkdown(`${m.label} ![bar](data:image/svg+xml;base64,${svg}) 남음 **${m.percentLeft}%** (사용 ${m.percentUsed}%)${m.timeLeft ? ` · ${m.timeLeft} 남음` : ''}${reset}\n\n`)
    }
    md.appendMarkdown(`<span style="color:${QUOTA_COLOR};">위 ▀ = 토큰 잔량</span> · <span style="color:${TIME_COLOR};">아래 ▄ = 시간 잔량</span>\n\n`)
    if (fetchedAt) md.appendMarkdown(`갱신: ${fetchedAt.toLocaleTimeString()}`)
    if (lastError) md.appendMarkdown(`\n\n$(warning) ${lastError}`)
    md.appendMarkdown('\n\n클릭하면 새로고침')
    md.supportThemeIcons = true
    return md
  }

  function render() {
    const width = config().get('barWidth', 8)
    const showNumbers = config().get('showNumbers', false)
    const list = meters(limits, new Date(), width)
    const shown = new Set(list.map((m) => m.kind))
    for (const [kind, item] of items) if (!shown.has(kind) && kind !== 'context') item.hide()
    renderContext()

    if (list.length === 0) {
      const item = itemFor('status', 0)
      item.text = '$(pulse) Claude'
      item.tooltip = lastError ? `Bar Claude Meter: ${lastError}` : 'Bar Claude Meter: 불러오는 중…'
      item.show()
      return
    }
    items.get('status')?.hide()

    const tip = tooltip(list)
    list.forEach((m, i) => {
      const item = itemFor(m.kind, i)
      item.text = (lastError ? '$(warning) ' : '') + meterText(m, showNumbers)
      item.color = m.percentUsed >= WARN_AT ? undefined : QUOTA_COLOR
      item.backgroundColor =
        m.percentUsed >= ERROR_AT
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : m.percentUsed >= WARN_AT
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined
      item.tooltip = tip
      item.show()
    })
  }

  const cacheFile = path.join(context.globalStorageUri.fsPath, 'usage.json')
  /** force: a click, which skips the cache's freshness (never its 429 cooldown). */
  async function refresh(force = false) {
    const r = await cachedUsage(cacheFile, MIN_FETCH_GAP_MS, force === true)
    if (r.body) {
      const next = limitsFromUsage(r.body)
      if (next.length > 0) limits = next
    }
    if (r.fetchedAt) fetchedAt = new Date(r.fetchedAt)
    lastError = r.error ? REASONS[r.error.reason] + (r.error.detail ? ` (${r.error.detail})` : '') : undefined
    render()
  }

  // Keep the time bar moving between fetches.
  const tick = setInterval(render, 60_000)
  const watch = setInterval(watchTranscript, TRANSCRIPT_POLL_MS)
  context.subscriptions.push(
    { dispose: () => { clearInterval(tick); clearInterval(watch) } },
    vscode.commands.registerCommand('barClaudeMeter.refresh', () => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('barClaudeMeter')) render()
    }),
  )

  // Window opened.
  render()
  void refresh()
  void watchTranscript()
}

function deactivate() { }

module.exports = { activate, deactivate }
