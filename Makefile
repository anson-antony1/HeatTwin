.PHONY: dev demo warm numbers test check-sources setup
setup:
	python3 -m venv .venv && . .venv/bin/activate && pip install fastapi uvicorn pydantic numpy scipy pyyaml requests pytest pythermalcomfort httpx bleak
	cd web && npm install
dev:
	(. .venv/bin/activate && uvicorn engine.api:app --reload --port 8000) & (cd web && npm run dev)
# Demo: engine WITHOUT auto-reload (a file save would empty the demo cache), then `make warm` in another terminal.
demo:
	(. .venv/bin/activate && uvicorn engine.api:app --port 8000) & (cd web && npm run dev)
warm:
	. .venv/bin/activate && python3 scripts/warm_demo.py http://127.0.0.1:8000
# Every headline/comparison number for docs, PLAN §7 and slides (live NWS for the comparison if reachable).
numbers:
	. .venv/bin/activate && python3 scripts/demo_numbers.py
test:
	. .venv/bin/activate && pytest engine -q
	cd web && npx vitest run
check-sources:
	. .venv/bin/activate && python3 engine/check_sources.py
