# Belkins Home for Claude Code

The team's skills and the `bh` CLI, for working client projects in Claude Code against the Belkins
Home engine. This repository is **published automatically** from the platform repository on every
green `main`; do not edit it here — a change made here is overwritten by the next publish.

## Install

Install Claude Code (https://claude.com/claude-code — the desktop app or the CLI), open it, and give
it this one line:

```
Set me up for Belkins Home: follow https://github.com/Belkins-Inc/belkins-home-plugin/blob/main/SETUP.md
```

The agent installs git, Node and the plugin, puts `bh` on the PATH, sets up your working directory,
and gives you a link to approve with your Google sign-in — nobody copies a token. By hand, the same steps:

You need Node 24 or newer, Claude Code, and a Belkins Home account with a token (an admin adds you).

```sh
claude plugin marketplace add Belkins-Inc/belkins-home-plugin
claude plugin install belkins-home@belkins-home
mkdir -p ~/.local/bin && ln -sf ~/.claude/plugins/marketplaces/belkins-home/plugin/bin/bh ~/.local/bin/bh
```

`bh` is TypeScript that Node 24 runs as it is: no dependencies and nothing to build.

## Your working directory

Work in a directory of your own, set up from the template here:

```sh
mkdir -p ~/work && cp -R ~/.claude/plugins/marketplaces/belkins-home/workspace ~/work/belkins-home
cd ~/work/belkins-home
bh login
bh projects
claude
```

Its `CLAUDE.md` keeps Claude on client work — through `bh`, never editing platform code — and its
`.claude/settings.json` lets `bh` run without a prompt each time. Say which client in your first
message; the session picks the project.

## Updating

```sh
claude plugin marketplace update belkins-home
```

Do it when a skill names a command `bh --help` does not list. Re-copy `workspace/` only if its
`CLAUDE.md` changed.

## Something is wrong

A defect in `bh`, the engine or a skill: open an issue here (`gh issue create --repo
Belkins-Inc/belkins-home-plugin --label bug`) — the platform team reads them.
