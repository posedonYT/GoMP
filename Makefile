GO      ?= go
NODE    ?= node
DOTNET  ?= dotnet
BIN     := bin
STUDIO_RIDS := win-x64 linux-x64 osx-x64 osx-arm64

.PHONY: all build test test-go test-node test-gamemode test-addons test-cpp test-studio studio studio-dist bench fuzz stress stress-quick run golden lint clean

all: build test

build:
	$(GO) build -o $(BIN)/gomp-server ./core/cmd/gomp-server
	$(GO) build -o $(BIN)/gomp-bot ./tools/bot/cmd/gomp-bot
	$(GO) build -o $(BIN)/gomp-stress ./tools/stress

test: test-go test-node test-gamemode test-compat test-cpp

test-go:
	$(GO) vet -composites=false ./...
	$(GO) test -race ./...

test-node:
	cd runtimes/node && $(NODE) --test "test/*.test.js"

# The freeroam gamemode (accounts, inventory, vehicles, shops, tuning) against a fake mp.
test-gamemode:
	cd server-files/packages/freeroam && $(NODE) --test "test/*.test.js"
	$(NODE) --test tools/dealership/generate.test.js

# RAGE.MP API compatibility (tools/compat: npm install there first).
test-compat:
	cd tools/compat && $(NODE) --test test/compat.test.js

# The data patches of the add-on installer (needs the .NET SDK).
test-addons:
	dotnet run --project tools/addons -c Release -- selftest

test-cpp:
	$(MAKE) -C client test

# GoMP Studio, the map and vehicle editor (tools/studio/README.md; needs the .NET 8 SDK
# with ASP.NET Core and a CodeWalker checkout, see tools/Directory.Build.props).
studio:
	$(DOTNET) build tools/studio/GoMP.Studio -c Release -o $(BIN)/studio

# With GOMP_GTA_DIR=<GTA V folder> the tests on the game files run too.
test-studio:
	$(DOTNET) test tools/studio/GoMP.Studio.Tests
	cd tools/studio/web && $(NODE) --test "test/*.test.mjs"

# One program per platform with .NET inside: dist/studio/<platform>/gomp-studio[.exe].
studio-dist:
	for rid in $(STUDIO_RIDS); do $(DOTNET) publish tools/studio/GoMP.Studio -c Release -r $$rid -o dist/studio/$$rid || exit 1; done

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
	rm -rf $(BIN) dist
