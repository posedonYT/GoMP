# Builds the platform-independent client core, its tests and the headless
# client on macOS/Linux. The game ASI is built with CMake on Windows.
CXX      ?= c++
CC       ?= cc
BUILD    := build
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Wpedantic -g
CFLAGS   ?= -O2 -g
INCLUDES := -Icore/include -Ithird_party/monocypher -Ithird_party/doctest
DEFINES  := -DGOMP_REPO_ROOT=\"$(abspath ..)\"

CORE_SRC := core/src/messages.cpp core/src/endpoint.cpp core/src/client.cpp core/src/socket.cpp core/src/crypto.cpp
CORE_OBJ := $(patsubst %.cpp,$(BUILD)/%.o,$(CORE_SRC)) $(BUILD)/monocypher.o

.PHONY: all test clean headless

all: $(BUILD)/gomp-tests $(BUILD)/gomp-headless

$(BUILD)/%.o: %.cpp $(wildcard core/include/gomp/*.hpp)
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $(DEFINES) -c $< -o $@

$(BUILD)/monocypher.o: third_party/monocypher/monocypher.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/libgompcore.a: $(CORE_OBJ)
	ar rcs $@ $^

$(BUILD)/gomp-tests: $(BUILD)/tests/test_core.o $(BUILD)/libgompcore.a
	$(CXX) $(CXXFLAGS) $^ -o $@

$(BUILD)/gomp-headless: $(BUILD)/headless/main.o $(BUILD)/libgompcore.a
	$(CXX) $(CXXFLAGS) $^ -o $@

headless: $(BUILD)/gomp-headless

test: $(BUILD)/gomp-tests
	./$(BUILD)/gomp-tests

clean:
	rm -rf $(BUILD)
