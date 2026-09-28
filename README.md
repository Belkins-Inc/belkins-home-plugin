# Belkins Home for Claude Code

The team's skills and the `bh` CLI, for working client projects in Claude Code against the Belkins
Home engine. This repository is **published automatically** from the platform repository on every
green `main`; do not edit it here — a change made here is overwritten by the next publish.

## Install

One command, on a bare machine — it installs whatever is missing (Node 24+, git, Claude Code), the
plugin, `bh`, and your working directory `~/work/belkins-home`, then gives you a link to approve with
your Google sign-in; nobody copies a token. Running it again is safe.

macOS or Linux, in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.sh | bash
```

Windows, in PowerShell — no WSL needed:

```powershell
irm https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.ps1 | iex
```

An admin must have added you first (Admin → People on https://home-next.belkins.io). Then open Claude
Code in `~/work/belkins-home` and name the client in your first message.

Or let Claude Code do it: give it this one line and it runs the same script, step by step with you:

```
Set me up for Belkins Home: follow https://github.com/Belkins-Inc/belkins-home-plugin/blob/main/SETUP.md
```

`bh` is TypeScript that Node 24 runs as it is: no dependencies and nothing to build. Inside Claude
Code the plugin puts it on the PATH by itself; the script also adds it for your own terminal.

## Your working directory

Its `CLAUDE.md` keeps Claude on client work — through `bh`, never editing platform code — and its
`.claude/settings.json` lets `bh` run without a prompt each time. Say which client in your first
message; the session picks the project.

## Updating

```sh
claude plugin marketplace update belkins-home
```

Do it when a skill names a command `bh --help` does not list, or run the install command again. Re-copy
`workspace/` only if its `CLAUDE.md` changed.

## Something is wrong

A defect in `bh`, the engine or a skill: open an issue here (`gh issue create --repo
Belkins-Inc/belkins-home-plugin --label bug`) — the platform team reads them.
