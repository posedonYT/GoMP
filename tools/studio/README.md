# GoMP Studio

A 3D editor for the server's custom map and for the add-on vehicles, on Windows,
Linux and macOS. It is a local web server (.NET 8, `gomp-studio`) with the editor
in the browser (three.js); it reads the GTA V files with
[CodeWalker.Core](https://github.com/dexyfex/CodeWalker) (MIT).

```
browser (three.js)  ⇄  gomp-studio (127.0.0.1:22100)  →  GTA V files (read only)
                              │ writes                 →  client-dist/addons/<pack>/dlc.rpf (vehicles)
                              ▼
                    server-files/maps/<name>.json  ←  maps.js in the gamemode reloads it live
```

## Running

A published Studio is one file with .NET inside (`make studio-dist`, below):

```
gomp-studio --gta "E:\GTAV"
```

It opens `http://127.0.0.1:22100`. Options:

| Option | Default |
|---|---|
| `--gta <folder>` | `GOMP_GTA_DIR`; without the game the map works with boxes instead of models |
| `--server-files <folder>` | `server-files` found up from the working directory or the program |
| `--addons <folder>` | `client-dist/addons` found the same way |
| `--port <n>` | `22100` (the server listens on 127.0.0.1 only) |
| `--no-browser` | the browser is opened |
| `--cache <folder>` | models converted for the browser: `%LOCALAPPDATA%/GoMP Studio/cache` (`~/.local/share/...` on Linux) |
| `--web <folder>` | the pages built into the program; `tools/studio/web` while working on them |

The game folder is needed for the world, the catalog of models and the 3D vehicles:
the archive keys are read from its `GTA5.exe`. On Linux and macOS use a copy of the
folder (or a mounted disk). The first start unpacks the program into `~/.net`
(`DOTNET_BUNDLE_EXTRACT_BASE_DIR` to change it); the first load of the game takes
10–30 seconds.

Linux and macOS: `chmod +x gomp-studio`. macOS does not run unsigned downloaded
programs: `xattr -d com.apple.quarantine gomp-studio` and, on Apple silicon,
`codesign --force --sign - gomp-studio` (a build made on a Mac is signed already).

## The map

Objects placed in Studio are saved to `server-files/maps/<name>.json`. The gamemode
(`server-files/packages/freeroam/maps.js`) watches the folder: a saved map appears
in the game at once, changes are applied as a diff (moved objects are moved, removed
ones destroyed), a broken file keeps the objects it had.

- **Карты**: create, rename, switch on/off, delete. **Объекты**: the list of the map.
  **Каталог**: models of the game (and of the installed add-on packs) by name.
- Place: pick a model in the catalog, click in the world (on the ground and objects).
  Move/rotate: `1`/`2` or the toolbar, numbers in the inspector, snapping (step, angle).
  `Ctrl+D` duplicate, `Ctrl+C`/`Ctrl+V`, `Del`, `Ctrl+Z`/`Ctrl+Y`, `F` to the object,
  «На землю» drops the selection onto what is under it, `Ctrl+S` saves.
- Camera: right mouse — look around, middle — pan, wheel — closer, `WASD`/`QE` — fly
  (`Shift` faster). Left click selects (`Shift` adds), `Esc` drops the selection.
- **Мир** shows the real city around (map files streamed by distance, with LODs).

In the game (admins): `/maps` — the maps and their objects, `/maps reload [name]`,
`/maps on|off <name>`, `/mapcursor` — moves the Studio camera to where you stand.

Map format (`"rot"` is the rotation in degrees as `SET_ENTITY_ROTATION` order 2:
Z, then X, then Y; at most 5000 objects per map):

```json
{ "format": "gomp-map", "version": 1, "name": "Площадь", "enabled": true,
  "objects": [ { "id": "a1b2", "model": "prop_bench_01a", "pos": [215.1, -810.3, 30.7],
                 "rot": [0, 0, 90], "dimension": 0, "alpha": 255, "group": "лавки" } ] }
```

`go run ./tools/mapcheck -map server-files/maps/<name>.json` checks a running server:
a bot goes to the objects and compares what the server streams with the file.

## Vehicles

**Машины** lists the packs of `client-dist/addons`. For a vehicle:

- data (`vehicles.meta`): name, make, class, engine sound, handling id, flags, wheels;
- characteristics (`handling.meta`) with units and ranges; a vehicle that uses the
  game's handling (g37s → `FELON2`) gets its own copy with «Сделать свою настройку»;
- colours (`carvariations.meta`, the game's palette with names), the mod kit
  (`carcols.meta`: parts, their names in LSC) and the light settings;
- checks: unknown class or sound, missing handling, values out of range, kit and
  light ids that clash with the game or another pack (the game takes the light id
  modulo 256);
- 3D: the model with its textures and paint, doors, bonnet and boot open,
  «Примерить» puts a tuning part of the pack on (and hides what it replaces);
- **XML-файлы**: any text file of the pack, edited as is (it must stay XML).

Saving writes into the pack's `dlc.rpf`; before the first change the pack is copied
to `dlc.rpf.bak`. The game reads the packs at start: `gomp-addons install` and a
restart of the game.

## Building and tests

Needs the .NET 8 SDK (with ASP.NET Core) and a CodeWalker checkout
(`tools/Directory.Build.props`: `~/tools/CodeWalker` or `-p:CodeWalkerDir=...`).

```
make studio          # bin/studio/gomp-studio (needs the .NET runtime)
make studio-dist     # dist/studio/{win-x64,linux-x64,osx-x64,osx-arm64}/gomp-studio
make test-studio     # C# (xUnit) and browser modules (node --test)
```

Tests with the game files run with `GOMP_GTA_DIR=<GTA V folder>` (the rest skip
them). The gamemode's map loader is tested by `make test-gamemode`.

| Path | What |
|---|---|
| `GoMP.Studio/` | the web server: API (`Api.cs`, `VehiclesApi.cs`), events (SSE), the built-in pages |
| `GoMP.Studio.Core/Maps` | the map format, checks, atomic saving |
| `GoMP.Studio.Core/Geometry` | GTA rotations (order 2) ⇄ quaternions, checked against the game |
| `GoMP.Studio.Core/Game` | the game files: catalog, world cells, the archive scan for Linux/macOS |
| `GoMP.Studio.Core/Export` | models → glTF (glb) with PNG textures, cached on disk |
| `GoMP.Studio.Core/Vehicles` | add-on packs: reading, checks, XML edits, writing into the rpf |
| `web/` | the editor (ES modules, three.js 0.170 in `web/vendor/three`) |
| `testdata/` | rotations measured in the game, a small synthetic add-on pack |
