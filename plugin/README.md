# Team plugin

Skills that every teammate's Claude Code loads — and the server agent too — so there is one way to
research, source, write and triage. The decisions behind them are in
[docs/decisions/tools.md](../docs/decisions/tools.md).

## Install

Teammates install it from **Belkins-Inc/belkins-home-plugin**, which every green `main` publishes
(`.github/workflows/publish-plugin.yml`): the skills, `bh` in `plugin/cli/`, the schema for `bh sql`,
and a working-directory template — and none of the platform's source, so a teammate needs no access
to this repository:

```sh
curl -fsSL https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.sh | bash   # macOS, Linux
irm https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.ps1 | iex          # Windows, no WSL
```

The scripts are `distribution/install.sh` and `distribution/install.ps1`.

The skills call `bh`, so the plugin carries it, and Claude Code puts the plugin's `bin/` on the PATH
of its shell: `bin/bh` (and `bin/bh.cmd` on Windows, for cmd and PowerShell) runs `plugin/cli/cli.ts` in the published
plugin, or `packages/bh` when the plugin is installed from this repository (Node 24 runs it as it is
— nothing to install or build), and the install script puts it on the PATH of the person's own terminal too. What the published repository
holds is `.github/scripts/build-plugin-repo.sh` and `distribution/`. Then `bh login`, which prints a link to approve in the browser; inside Claude Code the
agent runs `bh use <project>` for each session itself, so parallel sessions work different projects.

Being added to the platform, getting a token, which environment to point at and where to work:
[docs/onboarding.md](../docs/onboarding.md).

## Skills

| Skill | Use it for |
| --- | --- |
| `project-orientation` | the start and end of every session: `bh brief`, project memory, the hand-over |
| `client-brief` | turning a client's materials into the brief, rules, exclusions and questions |
| `persona-design` | who to write to inside a company |
| `segment-design` | which companies to look for, their sources, and judging them |
| `providers` | calling paid data providers through `bh call` (one reference per provider) |
| `sourcing-linkedin`, `sourcing-trustpilot`, `sourcing-web` | finding companies and people |
| `email-finding` | finding and verifying addresses; replacing one after a bounce |
| `strategy-and-plans` | strategies, plan templates, enrolling, launch readiness |
| `copywriting` | every step's copy, follow-ups, referrals and re-engagement |
| `sender-signatures` | a sender's text and HTML signature, with links and a photo |
| `inbox-triage` | classes, drafts, approvals, re-engagement and referrals from replies |
| `client-report` | the periodic report for the client |

`meeting-outcomes` comes with calendars and meetings (phase 8).

Skills name only `bh` commands that exist (`bh --help`). When a skill needs something `bh` cannot do,
fix `bh` rather than teaching a workaround.
