/** One session's record in the shared folder, one file per slot. */
export type Pulse = {
  v: 1
  sessionId: string
  /** Label shown for the session: the folder name, or what /pulse-name set. */
  name: string
  cwd: string
  /** working: a turn is running. waiting: the last turn ended, the session waits for you. */
  status: 'working' | 'waiting'
  /** When the current status began (epoch ms). */
  since: number
  /** When the last turn ended (epoch ms), null before the first. */
  lastReplyAt: number | null
  /** Last model request, tool call or turn edge (epoch ms). */
  lastActivityAt: number
  /** Written every 30 s while the session is open (epoch ms). */
  heartbeatAt: number
  /** Set when the session ends; the slot is free again. */
  endedAt?: number
}

export type Peer = Pulse & { slot: number }

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': {
      self: Pulse | null
      peers: Peer[]
      now: number
    }
  }
}
