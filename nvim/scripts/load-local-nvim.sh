#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec nvim \
  --cmd "set runtimepath+=$repo_root" \
  +"lua require('pi_intray').setup()"
