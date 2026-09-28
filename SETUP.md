# Setting up Belkins Home — instructions for the agent

You are Claude, running in the new teammate's Claude Code. Take them from a bare machine to a working
`bh`, step by step. Check before you change anything; skip a step whose check already passes. Say in
one line what you are doing before each step. Speak to the person in the language they write in.

Rules for the whole setup:

- **Never ask for a token in chat.** The person connects by approving a link in their browser
  (step 7); no token is copied by anyone.
- Ask before anything that needs `sudo` or opens a system dialog; tell the person what will appear.
- Do not clone or read any other repository, and do not write code. If a step fails in a way this
  file does not cover, stop and show the person the exact error.

## 1. The machine

Run `uname -s`. `Darwin` is macOS, `Linux` is Linux. On Windows, stop: `bh` needs a POSIX shell.
Tell the person to install WSL (`wsl --install` in PowerShell as administrator, then restart), open
Ubuntu, install Claude Code there, and start again inside it.

## 2. git

Check: `git --version`.

- macOS, missing: `xcode-select --install`. A system dialog opens; the person clicks *Install* and
  waits for it to finish. Check again.
- Linux, missing: `sudo apt-get update && sudo apt-get install -y git` (or the distribution's own
  package manager).

## 3. Node 24 or newer

Check: `node -v` prints `v24` or higher.

- macOS with Homebrew (`brew -v` works): `brew install node`, then check again.
- Otherwise, install nvm from its official script
  (`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash`), load it
  (`. "$HOME/.nvm/nvm.sh"`), then `nvm install 24 && nvm alias default 24`.

A `v22` or older left on the PATH is the most common failure later: `which -a node` must show the new
one first.

## 4. The plugin

```sh
claude plugin marketplace add Belkins-Inc/belkins-home-plugin
claude plugin install belkins-home@belkins-home
```

If `claude` is not on the PATH of your shell (the desktop app), ask the person to type these two
lines in the chat instead: `/plugin marketplace add Belkins-Inc/belkins-home-plugin`, then
`/plugin install belkins-home@belkins-home`.

Check: `ls ~/.claude/plugins/marketplaces/belkins-home/plugin/bin/bh` exists.

## 5. `bh` on the PATH

```sh
mkdir -p ~/.local/bin
ln -sf ~/.claude/plugins/marketplaces/belkins-home/plugin/bin/bh ~/.local/bin/bh
```

If `~/.local/bin` is not on the PATH (`echo $PATH`), add `export PATH="$HOME/.local/bin:$PATH"` to
the shell's rc file (`~/.zshrc` on macOS, `~/.bashrc` on Linux) and source it.

Check: `bh --help` prints the command list. `bh: Node … is too old` means step 3 is not done.

## 6. The working directory

```sh
mkdir -p ~/work
cp -R ~/.claude/plugins/marketplaces/belkins-home/workspace ~/work/belkins-home
```

Skip the copy if `~/work/belkins-home/CLAUDE.md` already exists. Client work always starts from this
directory: its `CLAUDE.md` keeps the agent on client work through `bh`.

## 7. Connect `bh` to their account

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

## 8. It works

```sh
bh whoami
bh projects
```

- `whoami` shows their address: logged in.
- `401` / `unauthorized`: the token was revoked — back to step 7.
- `projects` is empty: they are in the organisation but in no project — their admin adds them.

## 9. Done

Tell the person, in a few lines: setup is complete; from now on open Claude Code in
`~/work/belkins-home` (`cd ~/work/belkins-home && claude`, or choose that folder in the desktop app),
start each session by naming the client, and run `claude plugin marketplace update belkins-home`
when a skill mentions a command `bh --help` does not list.
