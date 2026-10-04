.PHONY: dev demo warm numbers test check-sources setup
# Engine port (default 8010; 8000 is often taken). The web's Vite proxy (/engine) follows it.
HEATTWIN_PORT ?= 8010
export HEATTWIN_PORT
setup:
	python3 -m venv .venv && . .venv/bin/activate && pip install fastapi uvicorn pydantic numpy scipy pyyaml requests pytest pythermalcomfort httpx bleak
	cd web && npm install
dev:
	(. .venv/bin/activate && uvicorn engine.api:app --reload --port $(HEATTWIN_PORT)) & (cd web && npm run dev)
# Demo: engine WITHOUT auto-reload (a file save would empty the demo cache), then `make warm` in another terminal.
demo:
	(. .venv/bin/activate && uvicorn engine.api:app --port $(HEATTWIN_PORT)) & (cd web && npm run dev)
warm:
	. .venv/bin/activate && python3 scripts/warm_demo.py http://127.0.0.1:$(HEATTWIN_PORT)
# Every headline/comparison number for docs, PLAN §7 and slides (live NWS for the comparison if reachable).
numbers:
	. .venv/bin/activate && python3 scripts/demo_numbers.py
test:
	. .venv/bin/activate && python -m pytest engine -q
	cd web && npx vitest run
check-sources:
	. .venv/bin/activate && python3 engine/check_sources.py
