// Command gomp-bot connects headless bots to a GoMP server for manual testing.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"time"

	"gomp/tools/bot"
	"gomp/wire/proto"
)

func main() {
	server := flag.String("server", "127.0.0.1:22005", "server address")
	n := flag.Int("n", 5, "number of bots")
	behavior := flag.String("behavior", "walker", "walker, driver, shooter or idle")
	name := flag.String("name", "bot", "name prefix")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var wg sync.WaitGroup
	for i := range *n {
		wg.Go(func() {
			b, err := bot.Connect(ctx, bot.Config{Server: *server, Name: fmt.Sprintf("%s%d", *name, i), Serial: fmt.Sprintf("cli-%d", i)})
			if err != nil {
				fmt.Fprintf(os.Stderr, "bot %d: %v\n", i, err)
				return
			}
			defer b.Close()
			b.Ready()
			var beh bot.Behavior
			seed := uint64(i + 1)
			home := proto.Vec3{}
			switch *behavior {
			case "driver":
				beh = bot.NewDriver(home, 40, 15, "/veh sultan", seed)
			case "shooter":
				beh = bot.NewShooter(home, 20, seed)
			case "idle":
				beh = bot.Idle{}
			default:
				beh = bot.NewWalker(home, 50, seed)
			}
			// Anchor behaviours at the spawn point chosen by the server's scripts.
			for {
				var spawned bool
				b.Pump(time.Now())
				b.View(func(x *bot.Bot) { spawned, home = x.Spawned, x.Pos })
				if spawned || ctx.Err() != nil {
					break
				}
				b.Flush(time.Now())
				time.Sleep(20 * time.Millisecond)
			}
			switch x := beh.(type) {
			case *bot.Walker:
				x.Home = home
			case *bot.Driver:
				x.Center = home
			case *bot.Shooter:
				x.Walker.Home = home
			}
			if err := b.Run(ctx, beh, 30); err != nil {
				fmt.Fprintf(os.Stderr, "bot %d: %v\n", i, err)
			}
		})
	}
	wg.Wait()
}
