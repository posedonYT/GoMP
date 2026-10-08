#!/usr/bin/env bash
# Starts a GoMP session with the add-on packs of client-dist/addons and reports
# whether the game loads (the client connects) or crashes while loading.
# A game that loaded is closed again. Used to find add-on packs that break GTA V.
#
#   tools/addons/testpack.sh            # from the repository root, the server running
set -u
cd "$(dirname "$0")/../.."
game=/e/GTAV
log=logs/testpack-launcher.log
rm -f "$game/gomp.log"
started=logs/testpack-started
touch "$started"
./bin/gomp-launcher.exe -server 127.0.0.1:22005 > "$log" 2>&1 &
launcher=$!
for _ in $(seq 1 200); do
  if grep -q "connected" "$game/gomp.log" 2>/dev/null; then
    echo "RESULT: loaded ($(ls client-dist/addons | tr '\n' ' '))"
    # KEEP=1 leaves the game running (for inspection); the launcher cleans up when it exits.
    [ "${KEEP:-0}" = 1 ] && exit 0
    taskkill //F //IM GTA5.exe > /dev/null 2>&1
    wait $launcher
    exit 0
  fi
  if grep -q "game closed\|did not start\|gomp-launcher:" "$log"; then
    wait $launcher
    # The game itself started only if ScriptHookV wrote its log during this run;
    # otherwise the Rockstar launcher failed (sign-in errors and the like).
    if [ -n "$(find bin/logs -name 'scripthookv-*' -newer "$started" 2>/dev/null)" ]; then
      echo "RESULT: crashed while loading ($(ls client-dist/addons | tr '\n' ' '))"
      exit 1
    fi
    echo "RESULT: the game did not start (see Documents/Rockstar Games/Launcher/launcher.log)"
    exit 3
  fi
  ping -n 3 127.0.0.1 > /dev/null
done
echo "RESULT: timeout"
exit 2
