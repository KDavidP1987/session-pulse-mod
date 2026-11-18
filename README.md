# session-pulse

A Claude Code mod that shows when things happened, so you can tell at a glance whether a session is still working, is waiting for you, or has gone quiet.

- **A time under every message.** Each prompt you send and each block of Claude's reply gets a dim time line under it, the moment it appeared: 24-hour or 12-hour, with the date if you want it.
- **A row above the prompt for every open session.** Each Claude Code session on the same machine that has this mod records its state in a small shared folder. Every session shows all of them:

  ```
  ⏱ this session: replied 14:32:05 (3m ago)
    ⚠ api-server: quiet 12m (working 25m)
    docs-site: working 2m
    website: replied 14:01:44 (34m ago)
  ```

  - **working Xm**: a turn is running, with model or tool activity in the last few minutes.
  - **quiet Xm**: a turn is running but nothing has happened for longer than your quiet warning (10 minutes by default). It may be stalled, or it may be waiting on a permission prompt. Either way, go and look.
  - **replied HH:MM:SS (Xm ago)**: the last turn ended at that time; the session is waiting for you.

Sessions that close drop off the list. Sessions that crash drop off within three minutes.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-pulse --marketplace KDavidP1987/session-pulse-mod
```

From a shell:

```
claude plugin install session-pulse --marketplace KDavidP1987/session-pulse-mod
```

Answer `y` to add the marketplace, then pick the **user** scope so every session you start loads it. Sessions that are already open pick it up when they restart.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `KDavidP1987/session-pulse-mod`, then Add plugin.

## Use

- `/pulse-name <name>` gives this session a name in the row (for example `/pulse-name billing fix`). Without a name, it goes back to the folder name. Two sessions in the same folder are told apart by a short id until you name them.
- Settings live in `/config` under session-pulse:
  - **Quiet warning (minutes)**, default 10.
  - **Time format**: `24-hour` (14:32:05, the default) or `12-hour` (2:32:05 PM).
  - **Show the date**: puts a short date before each time (`Nov 18 14:32:05`), default off.
  - **Show message times**, default on.
  - **Show other sessions**, default on.

## How it works

Each session writes one small JSON file to `~/.claude/session-pulse/` (or `$CLAUDE_CONFIG_DIR/session-pulse/`), one file per slot, at most 40. The file holds the session's id, folder, status and times, and nothing from the conversation. It is rewritten every 30 seconds and whenever a turn starts or ends. Every session reads the folder every 15 seconds. A slot whose session ended, or whose heartbeat is older than three minutes, is reused by the next session that starts.

Message times are recorded by the session the moment it first draws each message. Messages loaded from an earlier session (`--resume`) show no time, because the mod didn't see them arrive.

Times are your computer's local time.

## Requirements

Claude Code with mod (function hooks) support, v2.1.327 or later. Works on Windows, macOS and Linux.

## License

MIT © SkillEra IO, LLC
