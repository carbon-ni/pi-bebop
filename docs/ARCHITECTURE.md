# Architecture

`pi-bebop` is an independent Pi TypeScript extension for managing small,
project-local agent crews. It does not depend on `pi-intray` at runtime or
share its socket directory, flags, tools, or custom message type.

## Boundaries

```text
src/domain  <-  src/infra  <-  src/pi / src/tools
```

- `src/domain/` — pure protocol, crew-manifest, response-policy, and parsing
  rules. No Pi runtime or filesystem imports.
- `src/infra/` — filesystem, socket, git, environment, and RPC boundaries.
- `src/pi/` — flags, `/crew` command, renderer, lifecycle hooks, and socket
  runtime composition.
- `src/tools/` — discoverable Pi tool registrations. Bebop registers only
  `send_to_member`.
- `src/**/*.test.ts` — deterministic colocated `node:test` coverage.

## Isolation and configuration

Bebop owns these namespaces:

- Runtime Unix sockets: `~/.pi/bebop/<session-id>.sock`
- Runtime aliases: `~/.pi/bebop/<alias>.alias`
- Project crew manifest: `.pi/bebop/crew.json`
- Project member endpoints: `.pi/bebop/sockets/<member>.sock`
- Inbound custom messages: `bebop-session-message`

The manifest is trusted only when its resolved location is exactly the
project-local `.pi/bebop/crew.json`. It maps unique names and roles to relative
paths beneath `sockets/`; endpoint symlinks are transport details, not identity.

## Runtime lifecycle

- `pi --crew` starts Bebop's socket server.
- `pi --crew-socket <path>` starts the server and adopts the configured member
  represented by that endpoint.
- `/crew join <socket>` starts the server if needed, validates project trust,
  then claims the member endpoint.
- `/crew leave` releases only the current endpoint.
- `/crew stop` releases membership before stopping Bebop's server.
- Reload/resume restores active membership after revalidation. Shutdown always
  attempts endpoint release before server cleanup.

Server status is `stopped`, `online`, or `joined`. A session publishes its
socket and up to two aliases (session name and project/branch alias) under
Bebop's own runtime directory.

## Crew delivery

`send_to_member` resolves a unique member name or role from the active trusted
manifest and sends request-scoped RPC to its endpoint. The tool is active only
while the session is joined to a crew. A live endpoint owned by another session
is never overwritten; stale endpoints can be reclaimed.

Bebop intentionally does **not** register generic session discovery or direct
session-control tools. Those capabilities are outside crew management.

## Quality gates

- `npm run lint` — TypeScript check
- `npm test` — deterministic test suite
- `npm run test:coverage` — coverage gate
- `make all` — pre-push/CI gate

Commit subjects follow `<type>: <summary>` or `<type>(<scope>): <summary>`;
allowed types are `feat`, `fix`, `docs`, `test`, `chore`, and `refactor`.
