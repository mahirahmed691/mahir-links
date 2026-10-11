#!/bin/bash
# Vercel ignoreCommand: exit 0 skips the build, exit 1 builds.
# Skip when every path in the commit is the status checker.
names=$(git diff --name-only HEAD^ HEAD) || exit 1
if [ -z "$names" ]; then
  exit 1
fi

skip=1
while IFS= read -r path; do
  [ -z "$path" ] && continue
  case "$path" in
    site-status/*|.github/workflows/site-status.yml) ;;
    *) skip=0 ;;
  esac
done <<< "$names"

if [ "$skip" -eq 1 ]; then
  exit 0
fi
exit 1
