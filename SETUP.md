# Setting up Belkins Home — instructions for the agent

You are Claude, running in the new teammate's Claude Code. Take them from a bare machine to a working
`bh`, step by step. Check before you change anything; skip a step whose check already passes. Say in
one line what you are doing before each step. Speak to the person in the language they write in.

Rules for the whole setup:

- **Never ask for a token in chat.** The person connects by approving a link in their browser
  (step 2); no token is copied by anyone.
- Tell the person before anything that needs `sudo` or opens a system dialog; the rest you run yourself.
- Do not clone or read any other repository, and do not write code. If a step fails in a way this
  file does not cover, stop and show the person the exact error.

## 1. Install

**Never download a script and run it** (`curl … | bash`, `irm … | iex`, a saved `.ps1`): this
session's permission check refuses it, and the person would be left doing it by hand. Every step
below is a plain command you run yourself, one at a time, checking first. Run `uname -s` to know the
machine: `Darwin` is macOS, `Linux` is Linux, `MINGW…` / `MSYS…` (or no `uname` in PowerShell) is
Windows — no WSL is needed.

### a. Node 24 or newer

Check: `node -v` prints `v24` or higher.

- Windows: `winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements`.
  This shell does not see the new PATH until Claude Code restarts: for the rest of the setup put
  `export PATH="/c/Program Files/nodejs:$APPDATA/npm:$PATH";` in front of each command (in
  PowerShell: `$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path";`).
- macOS with Homebrew (`brew -v` works): `brew install node`.
- macOS or Linux without it — Node's official build into `~/.local`, nothing run from the download:

  ```sh
  arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/'); os=$(uname -s | tr A-Z a-z)
  file=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-$os-$arch.tar.gz" | head -1)
  mkdir -p ~/.local && curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" | tar -xz -C ~/.local --strip-components=1
  ```

  Then `export PATH="$HOME/.local/bin:$PATH"` in front of each later command.

A `v22` or older left on the PATH is the most common failure later: `which -a node` must show the new
one first.

### b. git

Check: `git --version`. Claude Code installs the plugin with it.

- Windows: `winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements`
  (then `/c/Program Files/Git/cmd` on the PATH as above).
- macOS: `xcode-select --install` opens a system dialog; the person clicks *Install* and waits.
- Linux: `sudo apt-get install -y git` (tell the person the password prompt is theirs).

### c. The plugin

Check: `claude --version`. If there is no `claude` in this shell (the desktop app has its own),
install the CLI with npm: `npm install -g @anthropic-ai/claude-code`. Then:

```sh
claude plugin marketplace add Belkins-Inc/belkins-home-plugin
claude plugin install belkins-home@belkins-home
```

If the marketplace is already there, `claude plugin marketplace update belkins-home` instead of `add`.

### d. The working directory, and `bh` on the PATH

```sh
node $HOME/.claude/plugins/marketplaces/belkins-home/plugin/cli/cli.ts setup
```

It copies the working directory to `~/work/belkins-home` and puts `bh` on the PATH of the person's
own terminal; a second run changes nothing. This session's shell does not see it yet: **in the
steps below, `bh` means `node $HOME/.claude/plugins/marketplaces/belkins-home/plugin/cli/cli.ts`**.

## 2. Connect `bh` to their account

An admin must have added them first — Admin → People on https://home-next.belkins.io, with their
`@belkins.io` address, and to the projects they will work. Without that, sign-in answers "has no
access yet": they ask their admin, and you carry on from here when they are added.

Run `bh login`. It answers with a link (`open`) and opens it in their browser where it can:

```json
{ "open": "https://home-next.belkins.io/cli/BCDF-GHJK", "expiresInMinutes": 10, "next": "bh login --wait" }
```

Give the person the link as a clickable link and tell them: open it, sign in with Google, check the
computer name and code, and press **Connect**. Then run `bh login --wait` with a timeout of ten
minutes — it returns as soon as they have pressed Connect, and saves their token itself. If it
answers that the link expired, run `bh login` again and give them the new link.

## 3. It works

```sh
bh whoami
bh projects
```

- `whoami` shows their address: logged in.
- `401` / `unauthorized`: the token was revoked — back to step 2.
- `projects` is empty: they are in the organisation but in no project — their admin adds them.

## 4. Done — the guide

Setup is finished when steps 1–3 pass. End with one message to the person, in their language, that
holds the two parts below — short lines and lists, no paragraphs of prose. Leave out anything that
does not apply to them (an empty `bh projects`, say, puts "ask your admin to add you to a project"
first).

### What to do next

1. **Restart Claude Code in the working directory** — `cd ~/work/belkins-home && claude`, or choose
   `~/work/belkins-home` in the desktop app. Its `CLAUDE.md` keeps every session on client work,
   and `bh` is on the PATH of their own terminal from a new window on.
2. **Name the client in the first message** — for example "Let's work on <project>: where are we?".
   The agent picks the project for that session (`bh use`), reads its state (`bh brief`) and
   proposes what to do first. Several sessions side by side can each work a different client.
   List the projects from step 3 by name so they can pick one.
3. **A new client** starts with their materials: the website, call notes or a transcript, a deck,
   ICP and exclusion lists — "Here is what we have on <client>, write the brief". A client that has
   no project yet needs an admin to create it.
4. **Decisions stay theirs.** Anything that spends money, sends, launches or changes rules — buying
   domains, launching a strategy, approving a reply — the agent prepares and asks them to confirm;
   nothing goes out on its own.
5. **The web app**, https://home-next.belkins.io, shows the same projects: leads, inbox, strategies,
   senders, meetings and tasks.
6. **Updates come by themselves** in `~/work/belkins-home`; `claude plugin marketplace update
   belkins-home` takes one at once. Something wrong with `bh` or a skill: say so to the agent — it
   files an issue for the platform team.

### What the platform does

Each line is one ask away; the skill in brackets is what the agent follows.

- **Client brief** — the brief, rules, exclusions and open questions for the client from their
  materials and our own research (`client-brief`).
- **Market** — segments (which companies) and personas (who inside them), the market sized with free
  counts, and a proposal approved before any money is spent (`segment-design`, `persona-design`).
- **Sourcing** — companies and people from LinkedIn data, Trustpilot reviews, websites and
  directories, each company judged against the segment with evidence (`sourcing-linkedin`,
  `sourcing-trustpilot`, `sourcing-web`, `providers`).
- **Contacts** — emails and phones found and verified; a bounced address replaced
  (`email-finding`). Do-not-contact lists are kept and checked.
- **Strategies** — email and LinkedIn sequences per segment and persona, leads enrolled, a launch a
  person presses, and the strategy kept full and healthy afterwards (`strategy-and-plans`).
- **Copy** — every step of every lead's plan written and checked against the house rules, previewed
  or sent as a test first (`copywriting`).
- **Sending** — lookalike domains bought, mailboxes ordered and warmed up, signatures with links and a
  photo, mail health and bounces watched (`sending-domains`, `sender-signatures`).
- **Inbox** — each reply classified, an answer drafted for approval, "not now" and referrals turned
  into follow-ups (`inbox-triage`).
- **Meetings** — free slots offered in the lead's time zone and booked on the client's calendar;
  call lists exported for callers.
- **Memory** — notes, hypotheses, client questions and tasks kept in the project, and a hand-over at
  the end of each session, so the next session (theirs or a colleague's) starts where this one
  stopped (`project-orientation`).
- **Reports** — the weekly or monthly report for the client, for a person to review and send
  (`client-report`). Any question about the data is answered from the database (`bh sql`).
