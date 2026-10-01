#!/bin/sh
# Homeroom checkout freshness check, run by Claude Code when a session starts
# (.claude/settings.json; .claude/README.md explains it).
#
# A coding agent is often opened on a fork of this app whose main is behind
# the app's canonical repository, and nothing in the checkout says so. This
# asks the canonical repository, which Homeroom names in
# .claude/homeroom-canonical-repo, where main is and, when HEAD does not
# contain that commit, prints a short notice for the agent.
#
# Read-only and advisory: it runs only git rev-parse, ls-remote and
# merge-base, prints nothing unless HEAD is behind, and always exits 0.
# Homeroom's hosted workers set SOCIAL_VIBECODING_DRIFT_CHECK=off, because
# the platform fixes the base commit of every hosted turn.

[ "${SOCIAL_VIBECODING_DRIFT_CHECK:-}" = off ] && exit 0
root=${CLAUDE_PROJECT_DIR:-.}
repo=$(sed -n 1p "$root/.claude/homeroom-canonical-repo" 2>/dev/null | tr -d '\r')
case $repo in
  ''|*[!A-Za-z0-9._/:@-]*) exit 0 ;;
esac
head=$(git -C "$root" rev-parse HEAD 2>/dev/null) || exit 0
upstream=$(GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
  git -C "$root" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=5 \
  ls-remote "$repo" refs/heads/main 2>/dev/null |
  awk '$2 == "refs/heads/main" { print $1; exit }')
case $upstream in
  ''|*[!0-9a-f]*) exit 0 ;;
esac
[ ${#upstream} -eq 40 ] || exit 0
[ "$upstream" = "$head" ] && exit 0
git -C "$root" merge-base --is-ancestor "$upstream" HEAD 2>/dev/null
case $? in
  # 1: HEAD does not contain it. 128: this clone has never seen the commit,
  # so HEAD's history cannot contain it either. Anything else: say nothing.
  1|128) ;;
  *) exit 0 ;;
esac
printf 'Checkout freshness: HEAD %.12s does not contain the canonical main of this app (%s main is at %s).' "$head" "$repo" "$upstream"
printf ' This checkout, often a fork, may describe code that has since changed.'
printf ' To answer a question about current behavior, read the canonical code: git fetch %s main, then git show FETCH_HEAD:<path> or git grep <pattern> FETCH_HEAD.' "$repo"
printf ' To change code, start from the exact base commit your work order (prepare_work) gives; never merge or rebase onto the canonical main yourself.'
printf ' See CLAUDE.md, "Check that this checkout is current".\n'
exit 0
