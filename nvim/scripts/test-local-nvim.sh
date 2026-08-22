#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

nvim --headless -u NONE \
  --cmd "set runtimepath+=$repo_root" \
  -c 'lua local plugin = require("pi_intray"); assert(plugin.hello() == "Hello from pi-intray.nvim"); plugin.setup(); vim.cmd("PiIntrayHello")' \
  -c 'quit'
