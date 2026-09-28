#!/usr/bin/env bash
# Sets up Belkins Home on macOS or Linux. In a terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.sh | bash
#
# Installs what is missing (git, Node 24+, Claude Code), then the plugin, puts bh on the PATH, copies
# the working directory to ~/work/belkins-home and, in a terminal, connects bh through a link to
# approve in the browser. Every step checks first, so running it again only finishes what is left.
set -euo pipefail

marketplace=$HOME/.claude/plugins/marketplaces/belkins-home
workspace=$HOME/work/belkins-home
export PATH=$HOME/.local/bin:$PATH

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
fail() {
  printf 'install: %s\n' "$1" >&2
  exit 1
}
node_major() { have node && node -v | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }

step 'git'
if ! have git; then
  case $(uname -s) in
  Darwin)
    xcode-select --install || true
    fail 'a system dialog installs git: click Install, wait for it to finish, then run this again'
    ;;
  *)
    have apt-get || fail 'install git with your package manager, then run this again'
    sudo apt-get update && sudo apt-get install -y git
    ;;
  esac
fi

step 'Node 24 or newer'
if [ "$(node_major)" -lt 24 ]; then
  if have brew; then
    brew install node
  else
    export NVM_DIR=$HOME/.nvm
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install 24 && nvm alias default 24
    set -eu
  fi
fi
[ "$(node_major)" -ge 24 ] || fail "node on the PATH is still $(node -v): which -a node shows which one comes first"

step 'Claude Code'
have claude || curl -fsSL https://claude.ai/install.sh | bash
have claude || fail 'claude is not on the PATH: open a new terminal and run this again'

step 'The belkins-home plugin'
if [ -d "$marketplace" ]; then
  claude plugin marketplace update belkins-home
else
  claude plugin marketplace add Belkins-Inc/belkins-home-plugin
fi
claude plugin install belkins-home@belkins-home
[ -x "$marketplace/plugin/bin/bh" ] || fail "the plugin did not install: no $marketplace/plugin/bin/bh"

step 'The working directory, and bh on the PATH'
node "$marketplace/plugin/cli/cli.ts" setup >/dev/null

step 'Connect bh to your account'
if bh whoami >/dev/null 2>&1; then
  echo 'Already connected.'
elif [ -t 1 ]; then
  bh login || fail 'bh login did not finish: run "bh login" again'
else
  echo 'Run "bh login" to connect.'
fi

printf '\n\033[32mDone. Open Claude Code in %s and name the client in your first message.\033[0m\n' "$workspace"
