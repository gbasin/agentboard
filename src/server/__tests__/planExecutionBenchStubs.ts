// The manager bench's stub executables (plan-execution rev 5): `gh` answers
// exactly what the composed path asks — the probe's auth, repository, and
// tree reads, the round's PR and green CI, the pinned merge, and (for
// integration landing, integration-candidates D4/D5) the branch update and
// the ref create and non-forced fast-forward on the bare origin — and
// anything else fails loudly;
// `openspec` answers the validation adapter's probe, strict validation,
// and delta reads with a valid, delta-free change.

/**
 * The stub gh; `treeFile` mirrors origin's base tree for the changes-on-base
 * check. Pull requests are numbered from 7 with their head branch kept in
 * `stateDir`; `pr view` reads the head from the bare `origin`, and `pr merge`
 * merges for real there (a clone, `--no-ff`, a push), refusing a moved head.
 * `update-branch` merges the PR's base into its head there. A ref create
 * answers 422 for an existing ref; a fast-forward answers 422 for a missing
 * branch or one that is not an ancestor. Before a fast-forward of `<b>`, a
 * `move-<b>` file in `stateDir` has an owner commit pushed onto it first
 * (its sha in `moved-<b>`), and a `rewrite-<b>` file resets it to a
 * parentless commit (in `rewritten-<b>`); each file is consumed once.
 * For promotions (integration-candidates 9.1): the repository allows merge
 * commits; `pr close` marks the pull request CLOSED; `pr merge` appends its
 * arguments to `merge-args`; a `move-master` file has an owner commit
 * pushed onto master at the next check-runs read (its sha in
 * `moved-master`); a `pending-ci` file reports every check in progress; and
 * a `hang-<b>` file makes the next fast-forward of `<b>` move the ref,
 * record its pid in `hung-pid`, and hang (a process dying mid-effect);
 * every fast-forward appends its branch to `fast-forwards`.
 * Every GIT_* variable is unset first: the pre-commit hook's must never
 * reach the stub's own git.
 */
export function benchGhStub(treeFile: string, origin: string, stateDir: string): string {
  const pending = (name: string) => `{"name":"${name}","status":"in_progress","conclusion":null,"started_at":"2026-01-01T00:00:00Z","completed_at":null}`
  const run = (name: string) => `{"name":"${name}","status":"completed","conclusion":"success","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"}`
  return `#!/bin/sh
for v in $(env | sed -n 's/^\\(GIT_[A-Z_]*\\)=.*/\\1/p'); do unset "$v"; done
STATE="${stateDir}"
ORIGIN="${origin}"
after() { want="$1"; shift; while [ $# -gt 1 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
head_of() { git --git-dir "$ORIGIN" rev-parse "refs/heads/$(cat "$STATE/pr-$1")"; }
field() { want="$1"; shift; for a in "$@"; do case "$a" in "$want="*) echo "\${a#*=}"; return ;; esac; done; }
WHO="-c user.email=owner@e -c user.name=Owner"
case "$*" in
  *"-X POST repos/acme/app/git/refs"*)
    b=$(field ref "$@"); b="\${b#refs/heads/}"
    git --git-dir "$ORIGIN" rev-parse -q --verify "refs/heads/$b" >/dev/null && { echo "Reference already exists (HTTP 422)" >&2; exit 1; }
    git --git-dir "$ORIGIN" update-ref "refs/heads/$b" "$(field sha "$@")" ;;
  *"-X PATCH repos/acme/app/git/refs/heads/"*)
    b="\${4#repos/acme/app/git/refs/heads/}"; sha=$(field sha "$@")
    echo "$b" >> "$STATE/fast-forwards"
    if [ -f "$STATE/move-$b" ]; then
      rm "$STATE/move-$b"; tmp=$(mktemp -d) && git clone -q -b "$b" "$ORIGIN" "$tmp/c" && cd "$tmp/c" \\
        && echo hand > "hand-$b.txt" && git add "hand-$b.txt" && git $WHO commit -q -m "owner commit on $b" \\
        && git push -q origin "HEAD:refs/heads/$b" && git rev-parse HEAD > "$STATE/moved-$b"; cd /; rm -rf "$tmp"
    fi
    if [ -f "$STATE/rewrite-$b" ]; then
      rm "$STATE/rewrite-$b"; c=$(echo rewritten | git $WHO --git-dir "$ORIGIN" commit-tree "$(git --git-dir "$ORIGIN" rev-parse "refs/heads/$b^{tree}")")
      git --git-dir "$ORIGIN" update-ref "refs/heads/$b" "$c" && echo "$c" > "$STATE/rewritten-$b"
    fi
    cur=$(git --git-dir "$ORIGIN" rev-parse -q --verify "refs/heads/$b") || { echo "Reference does not exist (HTTP 422)" >&2; exit 1; }
    git --git-dir "$ORIGIN" merge-base --is-ancestor "$cur" "$sha" || { echo "Update is not a fast forward (HTTP 422)" >&2; exit 1; }
    git --git-dir "$ORIGIN" update-ref "refs/heads/$b" "$sha" "$cur" || exit 1
    if [ -f "$STATE/hang-$b" ]; then rm "$STATE/hang-$b"; echo $$ > "$STATE/hung-pid"; exec sleep 600; fi ;;
  *"/update-branch"*)
    n=$(echo "$4" | sed 's#.*/pulls/\\([0-9]*\\)/.*#\\1#'); h=$(head_of "$n")
    [ "$h" = "$(field expected_head_sha "$@")" ] || { echo "expected head sha didn't match (HTTP 422)" >&2; exit 1; }
    br=$(cat "$STATE/pr-$n"); base=$(cat "$STATE/base-$n" 2>/dev/null || echo master)
    tmp=$(mktemp -d) && git clone -q -b "$br" "$ORIGIN" "$tmp/c" && cd "$tmp/c" \\
      && git -c user.email=gh@e -c user.name=GitHub merge -q --no-ff -m "Merge $base into $br" "origin/$base" \\
      && git push -q origin "HEAD:refs/heads/$br" || { cd /; rm -rf "$tmp"; exit 1; }
    cd /; rm -rf "$tmp"
    printf '%s' '{"message":"Updating pull request branch."}' ;;
  *"auth status"*) exit 0 ;;
  *check-runs*)
    if [ -f "$STATE/move-master" ]; then
      rm "$STATE/move-master"; tmp=$(mktemp -d) && git clone -q -b master "$ORIGIN" "$tmp/c" && cd "$tmp/c" \\
        && echo owner > owner-master.txt && git add owner-master.txt && git $WHO commit -q -m "owner commit on master" \\
        && git push -q origin HEAD:master && git rev-parse HEAD > "$STATE/moved-master"; cd /; rm -rf "$tmp"
    fi
    if [ -f "$STATE/pending-ci" ]; then printf '%s' '[{"check_runs":[${pending('ci')},${pending('e2e')}]}]'
    else printf '%s' '[{"check_runs":[${run('ci')},${run('e2e')}]}]'; fi ;;
  *"/status"*) printf '%s' '{"statuses":[]}' ;;
  *"git/trees/"*) cat "${treeFile}" ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"POST repos/acme/app/pulls "*)
    n=$(( $(cat "$STATE/count" 2>/dev/null || echo 6) + 1 )); echo "$n" > "$STATE/count"
    field head "$@" > "$STATE/pr-$n"; field base "$@" > "$STATE/base-$n"
    printf '{"number":%s,"url":"https://api.example.internal/repos/acme/app/pulls/%s","html_url":"https://example.internal/pr/%s"}' "$n" "$n" "$n" ;;
  *"pr view"*)
    n="$3"; h=$(head_of "$n")
    if [ -f "$STATE/closed-$n" ]; then printf '{"number":%s,"url":"https://example.internal/pr/%s","state":"CLOSED","headRefOid":"%s","mergeCommit":null}' "$n" "$n" "$h"
    elif [ -f "$STATE/merged-$n" ]; then printf '{"number":%s,"url":"https://example.internal/pr/%s","state":"MERGED","headRefOid":"%s","mergeCommit":{"oid":"%s"}}' "$n" "$n" "$h" "$(cat "$STATE/merged-$n")"
    else printf '{"number":%s,"url":"https://example.internal/pr/%s","state":"OPEN","headRefOid":"%s","mergeCommit":null}' "$n" "$n" "$h"; fi ;;
  *"pr close"*) touch "$STATE/closed-$3" ;;
  *"pr merge"*)
    echo "$*" >> "$STATE/merge-args"; n="$3"; want=$(after --match-head-commit "$@"); h=$(head_of "$n")
    [ "$h" = "$want" ] || { echo "Head branch was modified" >&2; exit 1; }
    tmp=$(mktemp -d) && git clone -q "$ORIGIN" "$tmp/c" && cd "$tmp/c" \\
      && git -c user.email=gh@e -c user.name=GitHub merge -q --no-ff -m "Merge pull request #$n" "origin/$(cat "$STATE/pr-$n")" \\
      && git push -q origin HEAD:master && git rev-parse HEAD > "$STATE/merged-$n" || { rm -rf "$tmp"; exit 1; }
    rm -rf "$tmp" ;;
  *"pr list"*) printf '%s' '[]' ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true},"allow_merge_commit":true}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`
}

/** The stub openspec: version 1.14.2, every change valid, no deltas. */
export function benchOpenspecStub(): string {
  return `#!/bin/sh
case "$1" in
  --version) echo "1.14.2" ;;
  validate) printf '{"items":[{"id":"%s","type":"change","valid":true,"issues":[]}],"summary":{}}' "$2" ;;
  show) printf '{"deltas":[]}' ;;
  *) printf 'unknown command'; exit 2 ;;
esac
`
}
