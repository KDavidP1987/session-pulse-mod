import { expect, test } from 'claude-code/testing'

import { ago, clock, describe } from '../hooks/register'
import type { Pulse } from '../types'

const BASE = '/home/me/.claude/session-pulse'
const T0 = 1_800_000_000_000

const pulse = (over: Partial<Pulse>): Pulse => ({
  v: 1,
  sessionId: 'other',
  name: 'other-project',
  cwd: '/work/other-project',
  status: 'waiting',
  since: T0,
  lastReplyAt: T0,
  lastActivityAt: T0,
  heartbeatAt: T0,
  ...over,
})

const BAND = {
  plugin: 'session-pulse',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

/** A fake engine beneath the mod: a clock, an env, a session id and an in-memory folder. */
function engine(on: any, files: Map<string, string>, clock: { t: number }) {
  on('clock.now', () => ({ value: clock.t }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'me-session' }))
  on('command.register', () => ({ value: { command: 'pulse-name' } }))
  // The kit hands paths over as this machine spells them (C:\home\... on Windows).
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: key(e.path) === BASE || files.has(key(e.path)),
  }))
  on('fs.list', () => ({
    value: [...files.keys()].map(p => ({ name: p.split('/').pop(), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(key(e.path), e.text)

    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('time words', () => {
  expect(ago(4_000)).toBe('4s')
  expect(ago(125_000)).toBe('2m')
  expect(ago(3_900_000)).toBe('1h05m')
})

test('clock styles: 24-hour, 12-hour, with a date', () => {
  // Built from local parts, so the test holds in any time zone.
  const at = new Date(2026, 10, 18, 14, 32, 5).getTime()
  const midnight = new Date(2026, 0, 3, 0, 7, 9).getTime()
  const noon = new Date(2026, 0, 3, 12, 0, 0).getTime()
  expect(clock(at)).toBe('14:32:05')
  expect(clock(at, { is12Hour: true, showDate: false })).toBe('2:32:05 PM')
  expect(clock(midnight, { is12Hour: true, showDate: false })).toBe('12:07:09 AM')
  expect(clock(noon, { is12Hour: true, showDate: false })).toBe('12:00:00 PM')
  expect(clock(at, { is12Hour: false, showDate: true })).toBe('Nov 18 14:32:05')
  expect(clock(midnight, { is12Hour: true, showDate: true })).toBe('Jan 3 12:07:09 AM')
})

test('a working session with no activity past the threshold is flagged', () => {
  const p = pulse({ status: 'working', since: T0, lastActivityAt: T0 })
  expect(describe(p, T0 + 5 * 60_000, 10 * 60_000).isStalled).toBe(false)
  const late = describe(p, T0 + 12 * 60_000, 10 * 60_000)
  expect(late.isStalled).toBe(true)
  expect(late.text).toBe('quiet 12m (working 12m)')
})

test('the session claims a free slot and records its turns', async ($, on) => {
  const files = new Map<string, string>()
  const clock = { t: T0 }
  engine(on, files, clock)
  // Slot 00 is held by a live session, slot 01 by one that went quiet long ago.
  files.set(`${BASE}/slot-00.json`, JSON.stringify(pulse({ sessionId: 'live' })))
  files.set(`${BASE}/slot-01.json`, JSON.stringify(pulse({ sessionId: 'dead', heartbeatAt: T0 - 60 * 60_000 })))

  await $.session.start({ cwd: '/work/my-project', surface: 'terminal', isInteractive: true })
  const mine = JSON.parse(files.get(`${BASE}/slot-01.json`)!) as Pulse
  expect(mine.sessionId).toBe('me-session')
  expect(mine.name).toBe('my-project')
  expect(mine.status).toBe('waiting')

  clock.t = T0 + 1_000
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect((JSON.parse(files.get(`${BASE}/slot-01.json`)!) as Pulse).status).toBe('working')

  clock.t = T0 + 61_000
  await $.turn.complete({ reason: 'answer', turnId: 't1', text: 'done' } as any)
  const after = JSON.parse(files.get(`${BASE}/slot-01.json`)!) as Pulse
  expect(after.status).toBe('waiting')
  expect(after.lastReplyAt).toBe(T0 + 61_000)
})

test('the time format and date settings reach the band', { options: { timeFormat: '12-hour', showDate: true } }, async ($, on) => {
  const files = new Map<string, string>()
  const replied = new Date(2026, 10, 18, 14, 32, 5).getTime()
  const clock = { t: replied + 3 * 60_000 }
  engine(on, files, clock)
  files.set(`${BASE}/slot-00.json`, JSON.stringify(pulse({ sessionId: 'a', name: 'alpha', heartbeatAt: clock.t, lastReplyAt: replied })))

  await $.session.start({ cwd: '/work/my-project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /alpha/ }))?.text).toContain('alpha: replied Nov 18 2:32:05 PM (3m ago)')
  await ui.unmount()
})

test('the band lists other live sessions, the quiet one first', async ($, on) => {
  const files = new Map<string, string>()
  const clock = { t: T0 + 20 * 60_000 }
  engine(on, files, clock)
  const t = clock.t
  files.set(`${BASE}/slot-00.json`, JSON.stringify(pulse({ sessionId: 'a', name: 'alpha', heartbeatAt: t, lastReplyAt: t - 120_000 })))
  files.set(`${BASE}/slot-01.json`, JSON.stringify(pulse({
    sessionId: 'b', name: 'beta', status: 'working', since: t - 15 * 60_000, lastActivityAt: t - 11 * 60_000, heartbeatAt: t,
  })))
  files.set(`${BASE}/slot-02.json`, JSON.stringify(pulse({ sessionId: 'c', name: 'gone', heartbeatAt: t, endedAt: t - 1 })))

  await $.session.start({ cwd: '/work/my-project', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toContain('no reply yet')
    expect((await ui.find({ type: 'Text', text: /beta/ }))?.text).toContain('⚠ beta: quiet 11m (working 15m)')
    expect((await ui.find({ type: 'Text', text: /alpha/ }))?.text).toContain('alpha: replied')
    expect(await ui.find({ type: 'Text', text: /gone/ })).toBeUndefined()
    await ui.unmount()
  }
})
