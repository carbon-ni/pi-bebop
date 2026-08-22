.PHONY: help
help: ## Lists the available commands. Add a comment with '##' to describe a command.
	@grep -E '^[a-zA-Z_-].+:.*?## .*$$' $(MAKEFILE_LIST)\
		| sort\
		| awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: doctor
doctor: ## Check required local tools
	@command -v luacheck >/dev/null || { echo "missing: luacheck (run through nix-shell)"; exit 1; }
	@command -v busted >/dev/null || { echo "missing: busted (run through nix-shell)"; exit 1; }

.PHONY: hooks-install
hooks-install: ## Install versioned git hooks
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push .githooks/commit-msg

.PHONY: test
test: ## Run unit tests with busted through shell.nix
	@if ! command -v busted >/dev/null; then nix-shell --run 'make test'; else busted lua/; fi

.PHONY: lint
lint: ## Run linter through shell.nix
	@if ! command -v luacheck >/dev/null; then nix-shell --run 'make lint'; else luacheck lua/ --exclude-files '**/*_spec.lua'; fi

.PHONY: check
check: ## Run all checks through shell.nix (doctor + lint + test)
	@if ! command -v luacheck >/dev/null || ! command -v busted >/dev/null; then nix-shell --run 'make check'; else $(MAKE) doctor lint test; fi

.PHONY: clean
clean: ## Clean any build artifacts
	rm -rf luacov.* doc/tags

.PHONY: helptags
helptags: ## Generate helptags for documentation
	nvim --headless --noplugin -u NONE -c "helptags doc" -c "quit"

.PHONY: install
install: ## Show how to enter the Nix dev environment
	@echo "Run: nix-shell"

.PHONY: test-local-nvim
test-local-nvim: ## Load plugin in headless Neovim and run hello command through shell.nix
	@if ! command -v nvim >/dev/null; then nix-shell --run 'make test-local-nvim'; else ./scripts/test-local-nvim.sh; fi

.PHONY: test-integration
test-integration: ## Run integration tests
	@test -x ./nvim-test.sh || { echo "missing executable integration runner: ./nvim-test.sh"; exit 1; }
	./nvim-test.sh

.PHONY: test-all
test-all: check test-integration ## Full test suite
