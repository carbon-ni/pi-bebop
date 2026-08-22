.PHONY: all build typecheck lint test security-check package-verify hooks-install hooks-uninstall

all: lint test security-check build

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

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

hooks-uninstall:
	git config --unset core.hooksPath || true
