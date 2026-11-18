import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peer, Pulse } from '../types'

// Shared folder: one small JSON file per slot, so sessions never write the same file.
const SLOTS = 40
// A slot whose heartbeat is older than this belongs to a session that is gone (closed or crashed).
const STALE_MS = 3 * 60_000
const HEARTBEAT_MS = 30_000
const REFRESH_MS = 15_000
// Activity writes are throttled; status changes are written at once.
const ACTIVITY_WRITE_MS = 10_000
// A message row first drawn this soon after the module loads is history (a resume or a reload), never stamped.
const HISTORY_MS = 5_000

const self = atom({ plugin: 'session-pulse', key: 'self' } as const, null)
const peers = atom({ plugin: 'session-pulse', key: 'peers' } as const, [])
const now = atom({ plugin: 'session-pulse', key: 'now' } as const, 0)

type Engine = EngineInterface

/** The module's own working state. A reload starts it over; the slot file and $.state keep the rest. */
const S = {
  dir: undefined as string | null | undefined,
  slot: -1,
  record: null as Pulse | null,
  lastWriteAt: 0,
  isInteractive: false,
  turnActive: false,
  loadedAt: 0,
  stallMs: 10 * 60_000,
  showTimes: true,
  showOthers: true,
  // Message id -> when this session first drew it (null: history, no stamp).
  stamps: new Map<string, number | null>(),
}

const pad = (n: number) => String(n).padStart(2, '0')

export const clock = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)

  return `${h}h${pad(m % 60)}m`
}

export const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const isLive = (p: Pulse, at: number) => p.endedAt === undefined && at - p.heartbeatAt < STALE_MS

/** One line describing a session's state at `at`. */
export const describe = (p: Pulse, at: number, stallMs: number) => {
  if (p.status === 'working') {
    const quiet = at - p.lastActivityAt
    if (quiet >= stallMs) {
      return { text: `quiet ${ago(quiet)} (working ${ago(at - p.since)})`, isStalled: true }
    }

    return { text: `working ${ago(at - p.since)}`, isStalled: false }
  }
  if (p.lastReplyAt === null) return { text: 'no reply yet', isStalled: false }

  return { text: `replied ${clock(p.lastReplyAt)} (${ago(at - p.lastReplyAt)} ago)`, isStalled: false }
}

const slotFile = (base: string, n: number) => `${base}/slot-${pad(n)}.json`

async function folder($: Engine) {
  if (S.dir !== undefined) return S.dir
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const root = config ?? (home ? `${home.replace(/[\\/]+$/, '')}/.claude` : null)
  S.dir = root === null ? null : `${root}/session-pulse`

  return S.dir
}

async function readSlot($: Engine, base: string, n: number): Promise<Pulse | null> {
  try {
    const value = JSON.parse(String(await $.fs.read(slotFile(base, n)))) as Pulse

    return value && value.v === 1 ? value : null
  } catch {
    return null
  }
}

async function readAll($: Engine): Promise<Peer[]> {
  const base = await folder($)
  if (base === null || !(await $.fs.exists(base))) return []
  const names = new Set((await $.fs.list(base)).map(entry => entry.name))
  const out: Peer[] = []
  for (let n = 0; n < SLOTS; n++) {
    if (!names.has(`slot-${pad(n)}.json`)) continue
    const p = await readSlot($, base, n)
    if (p !== null) out.push({ ...p, slot: n })
  }

  return out
}

async function write($: Engine) {
  const base = await folder($)
  const record = S.record
  if (base === null || record === null || S.slot < 0) return
  S.lastWriteAt = await $.clock.now()
  await update($, self, () => record)
  // A failed write (disk, permissions) must never hold up a tool call or a turn.
  await $.fs.write(slotFile(base, S.slot), JSON.stringify(record)).catch(() => undefined)
}

/** Takes this session's slot: the one it already holds, else the first free or stale one. */
async function claim($: Engine) {
  const base = await folder($)
  const record = S.record
  if (base === null || record === null) return
  const at = await $.clock.now()
  const all = await readAll($)
  const held = new Map(all.map(p => [p.slot, p]))
  let pick = all.find(p => p.sessionId === record.sessionId)?.slot ?? -1
  for (let n = 0; pick < 0 && n < SLOTS; n++) {
    const p = held.get(n)
    if (p === undefined || !isLive(p, at)) pick = n
  }
  if (pick < 0) return
  S.slot = pick
  // Two sessions in one folder are told apart by a short id.
  const twin = all.some(p => p.sessionId !== record.sessionId && isLive(p, at) && p.cwd === record.cwd)
  if (twin && S.record !== null && S.record.name === baseName(S.record.cwd)) {
    S.record = { ...S.record, name: `${S.record.name}#${S.record.sessionId.slice(0, 4)}` }
  }
  await write($)
}

async function begin($: Engine, cwd: string) {
  const at = await $.clock.now()
  const sessionId = await $.session.id()
  S.record = {
    v: 1,
    sessionId,
    name: baseName(cwd),
    cwd,
    status: 'waiting',
    since: at,
    lastReplyAt: null,
    lastActivityAt: at,
    heartbeatAt: at,
  }
  // Keep what this session wrote before a reload.
  const before = (await readAll($)).find(p => p.sessionId === sessionId && p.endedAt === undefined)
  if (before !== undefined) {
    const { slot: _slot, ...kept } = before
    S.record = { ...kept, heartbeatAt: at }
  }
  await claim($)
}

async function refresh($: Engine) {
  const at = await $.clock.now()
  await update($, now, () => at)
  if (!S.showOthers) return
  const mine = S.record?.sessionId
  const live = (await readAll($)).filter(p => p.sessionId !== mine && isLive(p, at))
  await update($, peers, () => live)
}

// Every change to S.record re-reads S.record after the last await, so a hook that ran meanwhile is never undone.
async function heartbeat($: Engine) {
  const id = await $.session.id()
  if (S.record === null) return
  // A /clear goes on under a new session id with no session.start.
  if (id !== S.record.sessionId) {
    await begin($, S.record.cwd)

    return
  }
  const base = await folder($)
  if (base === null) return
  const onDisk = await readSlot($, base, S.slot)
  const at = await $.clock.now()
  if (S.record === null) return
  S.record = { ...S.record, heartbeatAt: at }
  if (onDisk !== null && onDisk.sessionId !== S.record.sessionId) {
    await claim($)
  } else {
    await write($)
  }
}

async function mark($: Engine, change: Partial<Pulse>, force: boolean) {
  if (S.record === null) return
  const at = await $.clock.now()
  S.record = { ...S.record, ...change, lastActivityAt: at }
  if (force || at - S.lastWriteAt >= ACTIVITY_WRITE_MS) await write($)
}

async function stampOf($: Engine, id: string, isEligible: boolean) {
  let at = S.stamps.get(id)
  if (at === undefined) {
    const t = await $.clock.now()
    at = isEligible && t - S.loadedAt > HISTORY_MS ? t : null
    S.stamps.set(id, at)
  }

  return at
}

export const register: Register = (on, options) => {
  S.stallMs = Math.max(1, Number(options.stallMinutes ?? 10)) * 60_000
  S.showTimes = options.showMessageTimes !== false
  S.showOthers = options.showOtherSessions !== false
  S.stamps.clear()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    S.isInteractive = e.isInteractive
    S.loadedAt = await $.clock.now()
    if (!S.isInteractive) return result
    await $.command.register({
      name: 'pulse-name',
      description: 'Name this session in the session-pulse row (no name: back to the folder name)',
      argumentHint: '[name]',
    })
    await begin($, e.cwd)
    await refresh($)
    $.clock.every(HEARTBEAT_MS, () => heartbeat($))
    $.clock.every(REFRESH_MS, () => refresh($))

    return result
  })

  on('session.end', async ($, e, next) => {
    const at = await $.clock.now()
    if (S.record !== null && e.reason !== 'clear') {
      S.record = { ...S.record, endedAt: at }
      await write($).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'pulse-name' }, async ($, e) => {
    if (S.record === null) return { text: 'session-pulse is not running in this session.' }
    const name = e.args.trim().slice(0, 40) || baseName(S.record.cwd)
    S.record = { ...S.record, name }
    await write($)

    return { text: `This session shows as "${name}" in the session-pulse row.` }
  })

  on('prompt.submit', async ($, e, next) => {
    S.turnActive = true

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.turnActive = true
      await mark($, { status: 'working', since: await $.clock.now() }, true)
    } else {
      await mark($, {}, false)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await mark($, {}, false)

    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    await mark($, {}, false)
    const result = await next(e)
    await mark($, {}, false)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await mark($, { status: 'waiting', since: at, lastReplyAt: at }, true)
      // Let the final reply block draw (and be stamped) before the turn counts as over.
      $.clock.after(3_000, () => {
        S.turnActive = false
      })
    } else {
      await mark($, {}, false)
    }

    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const node = await next(e)
    if (!S.showTimes || !S.isInteractive) return node
    const at = await stampOf($, e.requestId, true)
    if (at === null) return node
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {node}
        <Text dimColor>  {clock(at)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const node = await next(e)
    if (!S.showTimes || !S.isInteractive) return node
    const at = await stampOf($, e.requestId, S.turnActive)
    if (at === null) return node
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {node}
        <Text dimColor>  {clock(at)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mine = await read($, self)
    const others = await read($, peers)
    const at = await read($, now)
    if (e.props.hasSurvey || mine === null || at === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const here = describe(mine, at, S.stallMs)
    const rows = others
      .map(p => ({ p, d: describe(p, at, S.stallMs) }))
      .sort((a, b) => Number(b.d.isStalled) - Number(a.d.isStalled) || a.p.name.localeCompare(b.p.name))
      .slice(0, Math.max(0, e.props.maxRows - 1))

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {'⏱ this session: '}
          {here.text}
        </Text>
        {rows.map(({ p, d }) => (
          <Text dimColor={!d.isStalled} color={d.isStalled ? 'warning' : undefined}>
            {`  ${d.isStalled ? '⚠ ' : ''}${p.name}: ${d.text}`}
          </Text>
        ))}
      </Box>
    )
  })
}
