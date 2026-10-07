//go:build !darwin

package main

import "syscall"

// lowerPriority renices this process (the bots) so the server wins CPU contention.
func lowerPriority() error {
	return syscall.Setpriority(syscall.PRIO_PROCESS, 0, 10)
}
