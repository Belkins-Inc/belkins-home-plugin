# Belkins Home for Claude Code

The team's skills and the `bh` CLI, for working client projects in Claude Code against the Belkins
Home engine. This repository is **published automatically** from the platform repository on every
green `main`; do not edit it here — a change made here is overwritten by the next publish.

## Install

Install Claude Code (https://claude.com/claude-code — the desktop app or the CLI; on Windows no WSL
is needed), open it, and give it this one line:

```
Set me up for Belkins Home: follow https://github.com/Belkins-Inc/belkins-home-plugin/blob/main/SETUP.md
```

The agent installs whatever is missing (Node 24+, git), the plugin, `bh` and your working directory
`~/work/belkins-home`, then gives you a link to approve with your Google sign-in — you type nothing,
and nobody copies a token. An admin must have added you first (Admin → People on
https://home-next.belkins.io). Then open Claude Code in `~/work/belkins-home` and name the client in
your first message.

Without Claude Code yet, one command does the same, Claude Code included:

```sh
curl -fsSL https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.sh | bash   # macOS, Linux
```

```powershell
irm https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.ps1 | iex          # Windows PowerShell
```

`bh` is TypeScript that Node 24 runs as it is: no dependencies and nothing to build. Inside Claude
Code the plugin puts it on the PATH by itself; `bh setup` adds it for your own terminal.

## Your working directory

Its `CLAUDE.md` keeps Claude on client work — through `bh`, never editing platform code — and its
`.claude/settings.json` lets `bh` run without a prompt each time and keeps the plugin up to date. Say which client in your first
message; the session picks the project.

## Updating

Claude Code started in the working directory keeps the plugin and `bh` current by itself: its
`.claude/settings.json` turns auto-update on for this marketplace. A new version is fetched in the
background within minutes of the first message and applies from the next session (or
`/reload-plugins`). A working directory made before that setting existed gets it from the install
command run again, or `bh setup`. By hand, any time:

```sh
claude plugin marketplace update belkins-home
```

Re-copy `workspace/` only if its `CLAUDE.md` changed.

## Something is wrong

A defect in `bh`, the engine or a skill: open an issue here (`gh issue create --repo
Belkins-Inc/belkins-home-plugin --label bug`) — the platform team reads them.
