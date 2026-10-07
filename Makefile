GO      ?= go
NODE    ?= node
BIN     := bin

.PHONY: all build test test-go test-node test-cpp bench fuzz stress stress-quick run golden lint clean

all: build test

build:
	$(GO) build -o $(BIN)/gomp-server ./core/cmd/gomp-server
	$(GO) build -o $(BIN)/gomp-bot ./tools/bot/cmd/gomp-bot
	$(GO) build -o $(BIN)/gomp-stress ./tools/stress

test: test-go test-node test-cpp

test-go:
	$(GO) vet -composites=false ./...
	$(GO) test -race ./...

test-node:
	cd runtimes/node && $(NODE) --test "test/*.test.js"

test-cpp:
	$(MAKE) -C client test

bench:
	$(GO) test -run '^$$' -bench . -benchmem ./wire/... ./core/...

fuzz:
	$(GO) test ./wire/proto -run '^$$' -fuzz FuzzUnmarshal -fuzztime 60s
	$(GO) test ./wire/proto -run '^$$' -fuzz FuzzValue -fuzztime 30s

golden:
	$(GO) test ./wire/proto -run TestGolden -update

stress: build
	$(BIN)/gomp-stress -bots 1000 -duration 60s -profile mixed

stress-quick: build
	$(BIN)/gomp-stress -bots 100 -duration 15s -ramp 3s -profile mixed

run: build
	$(BIN)/gomp-server -dir server-files -node-host runtimes/node/host.js

clean:
	rm -rf $(BIN)
