// Command desktop is a double-click launcher for the GoMP repository: one program,
// built three times with a different mode (make desktop):
//
//	server  - the GoMP server with the Node.js gamemode
//	game    - GTA V connected to the local server (gomp-launcher)
//	studio  - GoMP Studio, the map and vehicle editor
//
// The repository folder is set at build time: -X main.root=<folder> -X main.mode=<mode>.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var (
	root = "."
	mode = "server"
	gta  = `E:\GTAV`
)

func main() {
	var cmd *exec.Cmd
	switch mode {
	case "server":
		cmd = exec.Command(filepath.Join(root, "bin", "gomp-server.exe"), "-dir", "server-files", "-node-host", `runtimes\node\host.js`)
	case "game":
		cmd = exec.Command(filepath.Join(root, "bin", "gomp-launcher.exe"), "-server", "127.0.0.1:22005")
	case "studio":
		cmd = exec.Command(filepath.Join(root, "dist", "studio", "win-x64", "gomp-studio.exe"), "--gta", gta)
	default:
		fmt.Println("unknown mode", mode)
		os.Exit(2)
	}
	cmd.Dir = root
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	fmt.Println(mode+":", cmd.Path)
	err := cmd.Run()
	if err != nil {
		fmt.Println("\nстоп:", err)
	}
	// Keep the window open when something went wrong, to read the message.
	if err != nil || mode == "game" {
		time.Sleep(15 * time.Second)
	}
}
