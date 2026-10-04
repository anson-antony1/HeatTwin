.PHONY: dev demo sensor-demo warm numbers numbers-check e2e test check-sources setup
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
# Sensor demo in one command: engine + built-in Arduino bridge + web, opens the browser (scripts/demo_sensor.sh).
sensor-demo:
	./scripts/demo_sensor.sh
warm:
	. .venv/bin/activate && python3 scripts/warm_demo.py http://127.0.0.1:$(HEATTWIN_PORT)
# Every headline/comparison number for docs, PLAN §7 and slides (live NWS for the comparison if reachable).
numbers:
	. .venv/bin/activate && python3 scripts/demo_numbers.py
numbers-check:
	. .venv/bin/activate && python3 scripts/demo_numbers.py --check
# The Practice plan screen shows exactly docs/demo_numbers.json (needs make demo + make warm running; Playwright core
# from PLAYWRIGHT_CORE, uses the installed Google Chrome).
e2e:
	node scripts/e2e_headline.mjs http://localhost:5173
test:
	. .venv/bin/activate && python -m pytest engine -q
	cd web && npx vitest run
check-sources:
	. .venv/bin/activate && python3 engine/check_sources.py
