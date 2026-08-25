.PHONY: all build typecheck lint format-check package-check test verify-readme security-check package-verify hooks-install hooks-uninstall

all: format-check package-check lint build test verify-readme security-check

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

format-check:
	npm run format:check

package-check:
	npm run check:package-json

test:
	npm test

verify-readme:
	npm run verify:readme

package-verify:
	npm run verify:package

security-check:
	# Pi is a peer dependency; audit only the extension's production dependency tree.
	npm audit --omit=dev --audit-level=moderate

hooks-install:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push .githooks/commit-msg

hooks-uninstall:
	git config --unset core.hooksPath || true
