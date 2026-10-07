// Client-side scripts run inside the game client (phase 2: embedded V8 with
// the RAGE.MP client API). They are served over HTTP on port+1 already.
mp.events.add('echoReply', (...args) => {
  mp.gui.chat.push(`echo: ${JSON.stringify(args)}`);
});
