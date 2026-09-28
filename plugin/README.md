# Team plugin

Skills that every teammate's Claude Code loads — and the server agent too — so there is one way to
research, source, write and triage. The decisions behind them are in
[docs/decisions/tools.md](../docs/decisions/tools.md).

## Install

Teammates install it from **Belkins-Inc/belkins-home-plugin**, which every green `main` publishes
(`.github/workflows/publish-plugin.yml`): the skills, `bh` in `plugin/cli/`, the schema for `bh sql`,
and a working-directory template — and none of the platform's source, so a teammate needs no access
to this repository:

```
/plugin marketplace add Belkins-Inc/belkins-home-plugin
/plugin install belkins-home@belkins-home
ln -s ~/.claude/plugins/marketplaces/belkins-home/plugin/bin/bh /usr/local/bin/bh
```

The skills call `bh`, so the plugin carries it: `bin/bh` runs `plugin/cli/cli.ts` in the published
plugin, or `packages/bh` when the plugin is installed from this repository (Node 24 runs it as it is
— nothing to install or build), and the link puts it on the PATH. What the published repository
holds is `.github/scripts/build-plugin-repo.sh` and `distribution/`. Then `bh login --api <engine URL> --token <your token>`; inside Claude Code the
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
| `inbox-triage` | classes, drafts, approvals, re-engagement and referrals from replies |
| `client-report` | the periodic report for the client |

`meeting-outcomes` comes with calendars and meetings (phase 8).

Skills name only `bh` commands that exist (`bh --help`). When a skill needs something `bh` cannot do,
fix `bh` rather than teaching a workaround.
