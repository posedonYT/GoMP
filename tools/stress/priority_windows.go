package main

import "golang.org/x/sys/windows"

// lowerPriority drops this process (the bots) below normal priority so the
// server wins CPU contention.
func lowerPriority() error {
	return windows.SetPriorityClass(windows.CurrentProcess(), windows.BELOW_NORMAL_PRIORITY_CLASS)
}
