# Architecture

`pi-intray` is a Pi TypeScript extension that exposes running Pi sessions over local Unix sockets.

## Folder structure

- `src/domain/` — pure parsing, validation, formatting, and protocol rules. No Pi runtime or filesystem dependencies.
- `src/infra/` — socket, filesystem, git, environment, model, and other dependency boundaries.
- `src/pi/` — Pi extension commands, renderers, hooks, and runtime glue.
- `src/tools/` — Pi tool registrations (`list_sessions`, `send_to_session`, `send_to_member`).
- `src/**/*.test.ts` — colocated deterministic `node:test` coverage for domain behavior and runtime seams.
- `.githooks/` — versioned local hooks aligned with `Makefile` gates.
- `.github/workflows/` — CI gate that runs the same local command path.

## Dependency direction

```text
src/domain  <-  src/infra  <-  src/pi / src/tools
```

Rules:

1. Domain code stays pure and importable by tests.
2. Infrastructure owns IO and external dependencies.
3. Pi integration composes domain + infra; it does not hide business rules. The base socket runtime owns UUID socket lifecycle, aliases, subscriptions, and membership status.
4. Tools stay discoverable in `src/tools/` and delegate logic downward.
5. CI and local checks both use `make all`.

## Runtime status

The runtime status is minimal and deterministic: `stopped` when no server exists, `online` when the base server exists without crew membership, and `joined` when an active crew membership exists.

## Configuration

Canonical project configuration lives in:

- `package.json` for npm scripts and dependencies.
- `tsconfig.json` for TypeScript settings.
- `Makefile` for operator quality gates.
- `.githooks/` and `.github/workflows/ci.yml` for enforcement.

## Commit messages

Commit subjects use one canonical convention enforced by `.githooks/commit-msg`:

```text
<type>: <summary>
<type>(<scope>): <summary>
```

Allowed types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`.

Local lifecycle gates:

- pre-commit: `npm run lint` and `npm test`.
- pre-push/CI: `make all`.

Do not add competing command paths without updating `Makefile`, hooks, CI, and docs together.
