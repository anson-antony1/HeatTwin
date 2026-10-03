.PHONY: dev test check-sources setup
setup:
	python3 -m venv .venv && . .venv/bin/activate && pip install fastapi uvicorn pydantic numpy scipy pyyaml requests pytest pythermalcomfort
	cd web && npm install
dev:
	(. .venv/bin/activate && uvicorn engine.api:app --reload --port 8000) & (cd web && npm run dev)
test:
	. .venv/bin/activate && pytest engine -q
	cd web && npx vitest run
check-sources:
	. .venv/bin/activate && python3 engine/check_sources.py
