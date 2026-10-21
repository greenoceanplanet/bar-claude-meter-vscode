const { test } = require('node:test')
const assert = require('node:assert/strict')
const { lastContext } = require('../src/context')
const { contextText, contextWindowFor, formatLeft, limitsFromUsage, meters, meterText } = require('../src/meter')

const NOW = new Date('2026-10-21T12:00:00Z')

test('limitsFromUsage keeps 5h and 7d in order', () => {
  const body = {
    seven_day: { utilization: 41, resets_at: '2026-10-24T12:00:00Z' },
    five_hour: { utilization: 30, resets_at: '2026-10-21T14:30:00Z' },
    seven_day_opus: null,
  }
  assert.deepEqual(limitsFromUsage(body).map((l) => l.kind), ['five_hour', 'seven_day'])
  assert.deepEqual(limitsFromUsage(null), [])
})

test('meterText draws stacked bar', () => {
  // 70% quota left, 50% of 5h left → 4 cells, top 3 (rounded from 2.8), bottom 2
  const [m] = meters([{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-21T14:30:00Z' }], NOW, 4)
  assert.equal(meterText(m, true), '5h██▀⠀▏70% 2h30m')
  assert.equal(meterText(m, false), '5h██▀⠀▏')
})

test('contextText', () => {
  assert.equal(contextText(196_000, 200_000), 'C98%')
  assert.equal(contextWindowFor(250_000, undefined, 200_000), 1_000_000)
  assert.equal(contextWindowFor(150_000, undefined, 200_000), 200_000)
  assert.equal(contextWindowFor(51_000, 'claude-opus-5-5'), 1_000_000)
  assert.equal(contextWindowFor(51_000, 'claude-sonnet-4-6'), 1_000_000)
  assert.equal(contextWindowFor(51_000, 'claude-opus-4-5'), 200_000)
  assert.equal(contextWindowFor(51_000, 'claude-haiku-5-5'), 200_000)
  assert.equal(contextWindowFor(51_000, 'claude-opus-5-5', 300_000), 300_000)
})

test('lastContext takes the last main-loop assistant usage', () => {
  const line = (o) => JSON.stringify(o)
  const text = [
    line({ type: 'assistant', isSidechain: false, message: { model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
    line({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999 } } }),
    line({ type: 'user' }),
    '',
  ].join('\n')
  assert.equal(lastContext(text)?.tokens, 16)
})

test('formatLeft', () => {
  assert.equal(formatLeft(45 * 60_000), '45m')
  assert.equal(formatLeft((3 * 24 + 4) * 3600_000), '3d4h')
})

test('cachedUsage reuses a fresh reading and honors a cooldown without calling the API', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { cachedUsage } = require('../src/usage')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bcm-')), 'usage.json')
  const body = { five_hour: { utilization: 10 } }
  fs.writeFileSync(file, JSON.stringify({ body, fetchedAt: Date.now() }))
  assert.deepEqual(await cachedUsage(file, 60_000), { body, fetchedAt: JSON.parse(fs.readFileSync(file)).fetchedAt })
  fs.writeFileSync(file, JSON.stringify({ body, fetchedAt: 0, cooldownUntil: Date.now() + 60_000 }))
  const r = await cachedUsage(file, 60_000, true)
  assert.equal(r.error.reason, 'rate-limited')
  assert.deepEqual(r.body, body)
})
