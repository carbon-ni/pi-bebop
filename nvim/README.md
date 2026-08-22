# Nvim pi-intray

Send messages to PI instances via intray

## Requirements

- Neovim 0.5+
- pi-intray

## Installation

Install the plugin with your preferred package manager.

## Hello world

```lua
require("pi_intray").setup()
```

Then run:

```vim
:PiIntrayHello
```

Expected notification:

```text
Hello from pi-intray.nvim
```

## Load locally

```sh
./scripts/load-local-nvim.sh
```

Then run:

```vim
:PiIntrayHello
```

## Local smoke test

```sh
./scripts/test-local-nvim.sh
# or
make test-local-nvim
```
