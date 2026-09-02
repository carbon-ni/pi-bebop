.PHONY: all quiet-quality-gate build typecheck lint format-check test arch-check error-boundary-check security-check package-verify hooks-install hooks-check hooks-uninstall

all: quiet-quality-gate

quiet-quality-gate:
	@node scripts/quiet-quality-gate.mjs

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

format-check:
	npm run format:check


test:
	npm test


arch-check:
	npm run verify:arch

error-boundary-check:
	npm run verify:error-boundary


package-verify:
	npm run verify:package

security-check:
	# Pi is a peer dependency; audit only the extension's production dependency tree.
	npm audit --omit=dev --audit-level=moderate

hooks-install:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push .githooks/commit-msg

hooks-check:
	@hooks_path="$$(git config --get core.hooksPath || true)"; test "$$hooks_path" = ".githooks" || { echo "Expected core.hooksPath=.githooks (run make hooks-install)" >&2; exit 1; }
	@test -x .githooks/pre-commit
	@test -x .githooks/pre-push
	@test -x .githooks/commit-msg
	@grep -q "npm test --silent >\"\$$log\" 2>&1" .githooks/pre-commit
	@grep -qx "exec make all" .githooks/pre-push
	@grep -q "Commit subject must start with" .githooks/commit-msg
	@echo "Repository hooks configured: pre-commit runs silent npm test; pre-push runs make all; commit-msg is executable"

hooks-uninstall:
	git config --unset core.hooksPath || true
