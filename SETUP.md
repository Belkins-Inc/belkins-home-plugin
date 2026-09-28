# Setting up Belkins Home — instructions for the agent

You are Claude, running in the new teammate's Claude Code. Take them from a bare machine to a working
`bh`, step by step. Check before you change anything; skip a step whose check already passes. Say in
one line what you are doing before each step. Speak to the person in the language they write in.

Rules for the whole setup:

- **Never ask for a token in chat.** The person connects by approving a link in their browser
  (step 2); no token is copied by anyone.
- Tell the person before anything that needs `sudo`, opens a system dialog or installs software.
- Do not clone or read any other repository, and do not write code. If a step fails in a way this
  file does not cover, stop and show the person the exact error.

## 1. Install

One script installs what is missing (git, Node 24+, Claude Code's CLI), the plugin, `bh` on the PATH
and the working directory `~/work/belkins-home`. It checks before each step, so running it again is
safe. Run `uname -s` to pick it:

- `Darwin` (macOS) or `Linux`:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.sh | bash
  ```

- Windows (`MINGW…` / `MSYS…` from Git Bash, or no `uname` at all in PowerShell) — no WSL:

  ```sh
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.ps1 | iex"
  ```

Run it with a timeout of ten minutes. Run by you, it leaves out `bh login` (step 2 does it).

- It stops at a dialog, a `sudo` password or a winget prompt it cannot answer: give the person the
  same one line to paste into their own terminal (PowerShell on Windows), wait until they say it
  finished, then carry on.
- On macOS without git it opens a system dialog: the person clicks *Install*, waits, and you run the
  script again.
- It ends with `Done.` Check: `bh --help` prints the command list. If `bh` is not found in this
  session's shell yet, call it by its path for the rest of the setup:
  `node ~/.claude/plugins/marketplaces/belkins-home/plugin/cli/cli.ts`.

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

## 4. Done

Tell the person, in a few lines: setup is complete; from now on open Claude Code in
`~/work/belkins-home` (`cd ~/work/belkins-home && claude`, or choose that folder in the desktop app),
start each session by naming the client, and run `claude plugin marketplace update belkins-home`
when a skill mentions a command `bh --help` does not list.
