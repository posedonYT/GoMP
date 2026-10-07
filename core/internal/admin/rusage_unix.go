//go:build !windows

package admin

import (
	"runtime"
	"syscall"
)

// processUsage returns the CPU time and peak RSS (MB) of this process.
func processUsage() (cpuSeconds, rssMB float64) {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0, 0
	}
	cpuSeconds = float64(ru.Utime.Sec+ru.Stime.Sec) + float64(ru.Utime.Usec+ru.Stime.Usec)/1e6
	rssMB = float64(ru.Maxrss)
	if runtime.GOOS == "darwin" {
		rssMB /= 1 << 20 // bytes on macOS
	} else {
		rssMB /= 1 << 10 // kilobytes on Linux
	}
	return cpuSeconds, rssMB
}
