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

## 4. Done

Tell the person, in a few lines: setup is complete; from now on open Claude Code in
`~/work/belkins-home` (`cd ~/work/belkins-home && claude`, or choose that folder in the desktop app),
start each session by naming the client, and run `claude plugin marketplace update belkins-home`
when a skill mentions a command `bh --help` does not list.
