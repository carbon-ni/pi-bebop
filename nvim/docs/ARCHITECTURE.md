# Architecture

## Project shape

This repository is a Neovim Lua plugin for sending messages to Pi sessions through pi-intray.

Canonical structure:

```text
lua/
  init.lua                 Plugin entrypoint / compatibility shim only
  pi_intray/
    domain/                Pure parsing, validation, message-shaping rules
    lib/                   Shared Lua helpers with no Neovim side effects
    infra/                 Neovim APIs, shell/process calls, pi-intray IO
    fixtures/              Deterministic test fixtures
```

## Dependency direction

Allowed direction:

```text
init.lua -> infra -> domain/lib
```

Rules:

- `domain/` has no `vim`, shell, filesystem, network, or process calls.
- `infra/` owns all external dependencies: `vim.api`, jobs, commands, files, environment.
- `lib/` stays generic and reusable.
- Tests are colocated next to behavior as `*_spec.lua`.

## Configuration

One canonical format: Lua tables.

Precedence:

1. Built-in defaults
2. User setup table
3. Explicit command/function arguments

Environment variables are infra-only and must be converted to explicit Lua config before reaching domain code.

## Done definition

A change is done only when:

```sh
make check
```

passes locally, and CI runs the same target.

## Anti-patterns

- Domain code importing `vim` or spawning shell commands.
- CI-only checks with no local `make` equivalent.
- Hidden config precedence.
- Tests that require a live Pi session unless marked as integration.
