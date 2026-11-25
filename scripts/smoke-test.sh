#!/usr/bin/env bash
# Installs latest-or-bust as npm would publish it, into a throwaway directory
# with npm, and runs the installed command on a throwaway repository against
# the real registry: once with a dependency at its newest release, which must
# pass, and once with an old one, which must fail. That catches what the tests
# can't, since they run src/ in place: a file left out of the package, a
# runtime dependency listed under devDependencies, or ncurc.mjs not found
# from node_modules.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# prepack builds dist/.
tarball="$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n 1)"
mkdir "$work/install"
(cd "$work/install" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "$work/$tarball")
cli="$work/install/node_modules/.bin/latest-or-bust"

expected="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
if [ "$("$cli" --version)" != "$expected" ]; then
  echo "::error::The installed latest-or-bust --version doesn't print $expected"
  exit 1
fi

project="$work/project"
mkdir "$project"
cd "$project"
git init -q
commit() {
  git add -A
  git -c user.name=smoke -c user.email=smoke@example.com commit -qm "$1"
}
manifest() {
  printf '{ "name": "smoke", "private": true, "dependencies": { %s } }\n' "$1" >package.json
}

manifest ""
commit "No dependencies"
newest="$(npm view yaml version)"
manifest "\"yaml\": \"^$newest\""
if ! "$cli" HEAD; then
  echo "::error::latest-or-bust failed on yaml ^$newest, the newest release"
  exit 1
fi

manifest '"yaml": "^1.0.0"'
if "$cli" HEAD; then
  echo "::error::latest-or-bust passed yaml ^1.0.0, which isn't the newest release"
  exit 1
fi
echo "The installed package passes the newest release and fails an old one."
