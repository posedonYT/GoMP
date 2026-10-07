# client-dist

Files that `gomp-launcher` copies into the GTA V folder for a GoMP session and
removes when the game exits. They are not in git.

| File | Where from |
|---|---|
| `gomp.asi` | `client/build/gomp.asi` (build: see `client/CMakeLists.txt`) |
| `ScriptHookV.dll`, `dinput8.dll`, `xinput1_4.dll`, `args.txt` | `bin/` of the ScriptHookV archive for your game build, http://www.dev-c.com/gtav/scripthookv/ (redistribution is not allowed, download it yourself) |

`args.txt` contains `-nobattleye`: ScriptHookV works in story mode only, so the
session starts without BattlEye. After the game exits the launcher removes all
of these files, and the next normal launch of GTA V (including GTA Online) is
unmodified.
