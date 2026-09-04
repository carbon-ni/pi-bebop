.PHONY: all build typecheck lint format-check test security-check package-verify hooks-install hooks-uninstall

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
	# Registry audit endpoints are being retired; wrapper retries and records
	# infrastructure failures precisely while still failing on real findings.
	node scripts/security-check.mjs

hooks-install:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push .githooks/commit-msg .githooks/run-check

hooks-uninstall:
	git config --unset core.hooksPath || true
