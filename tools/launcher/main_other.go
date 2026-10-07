//go:build !windows

// Command gomp-launcher starts GTA V connected to a GoMP server (Windows only).
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "gomp-launcher runs on Windows only")
	os.Exit(1)
}
