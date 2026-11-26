.PHONY: check lint

check:
	cargo test --release
	cd web && npm ci && npm run build

lint:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cd web && npm ci && npm run lint
