.PHONY: all build typecheck lint format-check test security-check package-verify hooks-install hooks-check hooks-uninstall

all: format-check lint build test security-check

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
	@test -x .githooks/pre-push
	@grep -qx "make all" .githooks/pre-push
	@echo "Repository hooks configured: core.hooksPath=.githooks; executable pre-push runs make all"

hooks-uninstall:
	git config --unset core.hooksPath || true
