package main

import "syscall"

// lowerPriority moves this process (the bots) to background QoS so it runs on
// efficiency cores and does not steal performance cores from the server.
func lowerPriority() error {
	const prioDarwinProcess, prioDarwinBG = 4, 0x1000
	return syscall.Setpriority(prioDarwinProcess, 0, prioDarwinBG)
}
