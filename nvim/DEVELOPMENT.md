# Development Guardrails

## One command path

```sh
make help      # list commands
make check     # required local quality gate
make test-all  # includes integration when available
```

## Lifecycle

### Session start

```sh
git status --short
make doctor
```

### During work

- Write or update tests first.
- Keep pure logic in `lua/pi_intray/domain/`.
- Keep Neovim/Pi process boundaries in `lua/pi_intray/infra/`.

### Pre-commit

```sh
make check
```

Install versioned hooks once:

```sh
make hooks-install
```

### Pre-push / landing

```sh
make test-all
```

## Failure recovery

| Failure | Recovery |
| --- | --- |
| `luacheck: No such file or directory` | Enter dev shell or install `luacheck` with LuaRocks. |
| `busted: No such file or directory` | Enter dev shell or install `busted` with LuaRocks. |
| Integration script missing | Add `nvim-test.sh` or skip `make test-integration` until integration tests exist. |

## Done means

- Tests cover happy and unhappy paths.
- `make check` passes.
- Architecture boundaries in `docs/ARCHITECTURE.md` are respected.
- No CI-only guardrail exists without a local Make target.
