BUN ?= bun
AGENT_DIR ?=

# AGENT_DIR may come from CI or an untrusted environment, so keep it as data.
# $(value ...) returns the raw text (make never runs a $(shell ...) inside it),
# unexport stops make from auto-exporting the recursive command-line value and
# expanding it, and the recipe reads AGENT_DIR_RAW from the environment inside a
# quoted shell word. A double quote or backslash could escape that word, so both
# are rejected before the installer runs.
AGENT_DIR_RAW := $(value AGENT_DIR)
unexport AGENT_DIR
export AGENT_DIR_RAW
AGENT_DIR_GUARD = $(if $(findstring ",$(AGENT_DIR_RAW))$(findstring \,$(AGENT_DIR_RAW)),$(error AGENT_DIR must not contain double quotes or backslashes))
AGENT_DIR_FLAGS = $${AGENT_DIR_RAW:+--agent-dir "$$AGENT_DIR_RAW"}

.PHONY: install update uninstall test build check

install:
	$(AGENT_DIR_GUARD)
	$(BUN) install
	$(BUN) run build
	$(BUN) scripts/install.mjs $(AGENT_DIR_FLAGS)

# Reinstall the current checkout as a fresh extension generation.
update: install

uninstall:
	$(AGENT_DIR_GUARD)
	$(BUN) scripts/uninstall.mjs $(AGENT_DIR_FLAGS)

test:
	$(BUN) test

build:
	$(BUN) run build

check:
	$(BUN) run check
