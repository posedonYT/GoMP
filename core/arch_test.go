// Package core_test enforces the isolation rules between the core and
// everything else in the repository.
package core_test

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

type pkg struct {
	ImportPath   string
	Imports      []string
	TestImports  []string
	XTestImports []string
}

func listPackages(t *testing.T) []pkg {
	t.Helper()
	out, err := exec.Command("go", "list", "-json", "gomp/...").Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	var pkgs []pkg
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for dec.More() {
		var p pkg
		if err := dec.Decode(&p); err != nil {
			t.Fatal(err)
		}
		pkgs = append(pkgs, p)
	}
	return pkgs
}

// TestCoreIsolation: nothing outside gomp/core may import the core, and the
// core's production code may only depend on the public wire protocol.
func TestCoreIsolation(t *testing.T) {
	pkgs := listPackages(t)
	if len(pkgs) < 10 {
		t.Fatalf("only %d packages listed", len(pkgs))
	}
	for _, p := range pkgs {
		inCore := strings.HasPrefix(p.ImportPath, "gomp/core/") || p.ImportPath == "gomp/core"
		for _, imp := range p.Imports {
			if !inCore && strings.HasPrefix(imp, "gomp/core") {
				t.Errorf("%s imports the core package %s", p.ImportPath, imp)
			}
			if inCore && strings.HasPrefix(imp, "gomp/") && !strings.HasPrefix(imp, "gomp/core/") && !strings.HasPrefix(imp, "gomp/wire/") {
				t.Errorf("core package %s depends on %s (only gomp/wire is allowed)", p.ImportPath, imp)
			}
		}
		if !inCore {
			for _, imp := range append(p.TestImports, p.XTestImports...) {
				if strings.HasPrefix(imp, "gomp/core") {
					t.Errorf("tests of %s import the core package %s", p.ImportPath, imp)
				}
			}
		}
	}
}

// TestWireIsStandalone: the protocol packages must not depend on anything else
// in the repository, so third parties can implement clients from them.
func TestWireIsStandalone(t *testing.T) {
	for _, p := range listPackages(t) {
		if !strings.HasPrefix(p.ImportPath, "gomp/wire/") {
			continue
		}
		for _, imp := range p.Imports {
			if strings.HasPrefix(imp, "gomp/") && !strings.HasPrefix(imp, "gomp/wire/") {
				t.Errorf("%s imports %s", p.ImportPath, imp)
			}
		}
	}
}
