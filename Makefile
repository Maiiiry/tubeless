.DEFAULT_GOAL := help

.PHONY: help list verify validate inspect plan graph run agent ui require-file install build \
	lint format \
	format-check typecheck typecheck-run knip test test-run watch docs-check studio-check api-check api-generate pack \
	pack-verify tubeless check release website website-build

export_arg = $(if $(strip $(EXPORT)),--export "$(EXPORT)",)
project_arg = $(if $(strip $(PROJECT)),--project "$(PROJECT)",)
store_arg = $(if $(strip $(STORE)),--store "$(STORE)",)
port_arg = $(if $(strip $(PORT)),--port "$(PORT)",)
ui_command_arg = $(if $(strip $(COMMAND)),--command "$(COMMAND)",)
studio_arg = $(if $(strip $(STUDIO)),"$(STUDIO)",)
# `make tubeless ui` expresses `ui` as a second make goal. Forward that goal to
# the raw workbench target, then make the later named target a no-op.
tubeless_command = $(if $(filter tubeless,$(firstword $(MAKECMDGOALS))),$(word 2,$(MAKECMDGOALS)),)

help:
	@echo "tubeless"
	@echo
	@echo "Pipeline tools"
	@echo "  make list [PROJECT=path/to/tubeless.project.ts]"
	@echo "      List project pipeline IDs"
	@echo "  make verify FILE=path/to/module.ts [EXPORT=Name] [PROJECT=project-file]"
	@echo "      Load and verify a pipeline or command module; alias: make inspect"
	@echo "  make validate FILE=path/to/pipelines.yaml [ARGS=--json]"
	@echo "      Check YAML or JSON document structure without importing handlers"
	@echo "  make plan FILE=path/to/module.ts ARGS=\"--target publish --explain\""
	@echo "      Preview selected work without executing steps"
	@echo "  make graph FILE=path/to/module.ts ARGS=\"--markdown\""
	@echo "      Generate the pipeline or command Mermaid graph"
	@echo "  make run FILE=path/to/pipeline.ts ARGS=\"--source input.json\""
	@echo "      Run a project pipeline or exported pipeline or command"
	@echo "  make agent ARGS=\"--model gpt-5.4-mini\""
	@echo "      Prompt a workspace agent with live pipeline reporting"
	@echo "  make ui [STUDIO=path/to/tubeless.project.ts] [COMMAND=path/to/command.ts]"
	@echo "      Open the local run studio; a project or COMMAND enables browser launches"
	@echo
	@echo "Developing tubeless"
	@echo "  make install       Install exact dependencies from bun.lock"
	@echo "  make check         Run the complete package quality gate"
	@echo "  make website       Run the public docs site locally"
	@echo "  make website-build Build the public docs site"
	@echo "  make format        Format package sources and documentation"
	@echo "  make api-generate  Regenerate checked public API documentation"
	@echo "  make pack          Inspect and verify the publishable artifact"
	@echo "  make release       Bump patch, check, commit, tag, and push (BUMP=/VERSION=)"
	@echo
	@echo "Fast loops"
	@echo "  make build         Compile the library"
	@echo "  make lint          Lint sources without rebuilding"
	@echo "  make format-check  Check formatting without writing"
	@echo "  make typecheck     Build, then type-check library, examples, and tests"
	@echo "  make typecheck-run Type-check against the current build"
	@echo "  make knip          Report unused exports, files, and dependencies"
	@echo "  make test          Build, then run the vitest suite"
	@echo "  make test-run      Run the vitest suite against the current build"
	@echo "  make watch         Rebuild src and the Studio client on change, and re-run tests"
	@echo "  make docs-check    Validate the learning-surface docs"
	@echo "  make studio-check  Verify the generated Studio client bundle"
	@echo "  make api-check     Verify generated public API docs"
	@echo "  make pack-verify   Smoke-test the publishable artifact"

require-file:
	@if [ -z "$(FILE)" ]; then \
		echo "FILE is required (for example: make verify FILE=./examples/typed-import.ts)" >&2; \
		exit 2; \
	fi

verify: inspect

validate: require-file
	bun run tubeless -- validate $(ARGS) "$(FILE)"

list:
	bun run tubeless -- list $(project_arg) $(ARGS)

inspect: require-file
	bun run tubeless -- inspect $(export_arg) $(project_arg) $(ARGS) "$(FILE)"

plan: require-file
	bun run tubeless -- plan $(export_arg) $(project_arg) $(ARGS) "$(FILE)"

graph: require-file
	bun run tubeless -- graph $(export_arg) $(project_arg) $(ARGS) "$(FILE)"

run: require-file
	bun run tubeless -- run $(export_arg) $(project_arg) $(store_arg) "$(FILE)" -- $(ARGS)

agent:
	$(if $(filter agent,$(tubeless_command)),@:,bun run tubeless -- agent $(ARGS))

ui:
	$(if $(filter ui,$(tubeless_command)),@:,bun run tubeless -- ui $(ui_command_arg) $(export_arg) $(store_arg) $(port_arg) $(ARGS) $(studio_arg))

install:
	bun ci

build:
	bun run --silent build

lint:
	bun run lint

format:
	bun run format

format-check:
	bun run format:check

typecheck:
	bun run typecheck

typecheck-run:
	bun run typecheck:run

knip:
	bun run knip

test:
	bun run test

test-run:
	bun run test:run

# `dist/` is what tests and type checks resolve `tubeless` from, so rebuild it as
# sources change. The Studio client bundle is not a tsc output; regenerate it
# when a bundled source changes.
watch: build
	bun run studio:watch & bun run build:watch & bun run test:watch; wait

docs-check:
	bun run docs:check

studio-check:
	bun run studio:check

api-check:
	bun run --silent build
	bun run api:check

api-generate:
	bun run api:generate

pack:
	bun run --silent build
	bun run api:check
	bun run pack:dry-run
	bun run pack:verify

pack-verify:
	bun run --silent build
	bun run pack:verify

# Raw workbench escape hatch; prefer the named pipeline targets above.
tubeless:
	bun run tubeless -- $(tubeless_command) $(if $(filter ui,$(tubeless_command)),$(ui_command_arg) $(export_arg) $(store_arg) $(port_arg),) $(ARGS) $(if $(filter ui,$(tubeless_command)),$(studio_arg),)

website:
	cd website && bun run dev

website-build:
	cd website && bun run build

check:
	bun run check

release: install
	@$(if $(strip $(BUMP)),BUMP="$(BUMP)",) \
		$(if $(strip $(VERSION)),VERSION="$(VERSION)",) \
		bash scripts/cut-release.sh
