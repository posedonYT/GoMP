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
- The **Каталог** has categories (a drop-down: props, buildings, plants, …) and a
  search that ranks by relevance (exact name, then prefix, then words, then part of
  a name). Results come in pages of 200: «Показать ещё» loads the next. A hash
  searches by hash: `0x1a2b3c4d` (or the plain number). Models of the game that
  have no name in the name lists (about 5000 of 159000) are listed only by hash.
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

## Houses

The **Дома** tab edits `server-files/houses.json`, the definitions of the real estate
in the gamemode (`server-files/packages/freeroam/houses.js`):

```json
{ "format": "gomp-houses", "version": 1,
  "interiors": [ { "id": "studio", "name": "Студия", "spawn": [x, y, z], "heading": 90, "exit": [x, y, z],
                   "props": [ { "id": "p1", "model": "prop_couch_01", "pos": [x, y, z], "rot": [0, 0, 0] } ] } ],
  "classes": [ { "id": "econom", "name": "Эконом", "garage": 2, "interior": "studio" } ],
  "houses": [ { "id": 1001, "name": "Дом №1001", "cls": "econom", "price": 55000,
                "door": [x, y, z], "heading": 180, "interior": "studio" } ] }
```

- **interiors** are templates shared by the houses that use them: `spawn` and
  `heading` (where players appear), `exit` (the point that leads out) and decoration
  `props` (a model name or a hash; positions are in the world, where the interior is
  in the game). **classes** give a house its price list entry: garage size and the
  default interior. A **house** has a door point, the heading the player faces when
  coming out, and optionally its own `interior` instead of the class's.
- **Garage interiors** (optional): a house's garage can be a real place. The file's
  `garages` list holds the templates:

  ```json
  "garages": [ { "id": "garage6", "name": "Гараж на 6 мест", "spawn": [x, y, z], "heading": 90,
                 "exit": [x, y, z], "slots": [ { "pos": [x, y, z], "heading": 180 } ] } ]
  ```

  `spawn`/`heading` is where the owner appears when he walks in, `exit` the point that
  leads out, `slots` the places of the stored cars (1 to 50; the capacity is the
  smaller of the class's `garage` and the number of slots). Points are ground + 1,
  like a door; the cars are created 0.5 m lower. A class (`"garageInterior": "garage6"`)
  or a house (its own `garageInterior`, which wins) names the template. A house may also
  have a **`garagePoint`**: `{ "pos": [x, y, z], "heading": 0 }`, the entry outside the
  house, where the owner drives in; `heading` is the way the car faces when it comes
  out of the garage. Without a `garagePoint` cars drive in within 10 m of the door and
  come out on the road found by the client. Everything is optional: a file with no
  `garages`, or a class and house that resolve no template, keeps the old virtual
  garage (cars are put in at the door and taken out onto the road), and unknown fields
  are kept. The format stays version 1.
- Ids: houses are numbers, new ones get an id above every id in the file and above
  every id the database remembers (owners are kept per id, so a freed id is never
  reused for another house); the game's built-in houses are below 1000.
- Markers: every door is a cylinder with an arrow (green for sale, blue owned, white
  selected); the interior being edited shows its spawn point (blue) and exit
  (amber). Markers are hidden by walls and show faintly through them.
- Select with the mouse or the list, move with the gizmo (`1`/`2` move/rotate,
  `F` flies to it, `Del` removes a house); the forms on the right edit names,
  class, price, interior, coordinates.
- **Interior view**: the interior is shown from the game's MLO (the real rooms) at
  the interior's position, with the door portals outlined: the entrance filled in
  green, other ways out white, inner doors dim. «Выход у двери» puts the exit at the
  entrance portal, «Появление у двери» puts the spawn point just inside it.
- **Garages**: the list on the left has a «Гаражи» section (name, id, places, houses
  using it; «+ Новый гараж»). A garage shows its spawn point (blue), exit (amber ring)
  and one car box per slot; the same MLO view as for interiors helps to place them.
  Drag a slot with the gizmo; «Добавить место рядом» adds a slot 3.2 m to the right of
  the selected one (same heading); «Удалить место» removes it. A garage cannot be
  deleted while a class or house uses it. The class form and the house form have an
  «Интерьер гаража» select.
- **Garage point**: each house with one shows a purple car box (2 x 4.8 m, the arrow is
  the way the car faces when it comes out) and a thin line to its door; select it and
  move or rotate it with the gizmo. The house form, «Въезд в гараж (снаружи)»:
  «Двигать дверь» / «Двигать въезд», «На землю», **«Въезд у дороги»** (snaps to the
  nearest road node of the game and faces the road, via `GET /api/roads/nearest`; needs
  the game files on this PC), «К въезду», **«Убрать въезд»**; for a house without one
  **«Поставить въезд»** (6 m in front of the door, on the ground). A house whose garage
  template is set but which has no garage point is tagged «без въезда» in the list.
- **Decor**: «Редактировать декор» opens the interior's props as a map: the same catalog,
  gizmo, snapping, `Ctrl+D` and `Del` work on them. `Ctrl+S` saves; the Дома tab
  returns to the houses.
- `Ctrl+Z`/`Ctrl+Y` undo and redo, `Ctrl+S` saves. The server applies the saved
  file at once (players inside included, without a restart); a broken file keeps the
  old definitions. When the game server writes the file itself (the admin commands
  below), Studio is told over SSE and reloads it; unsaved changes ask first.
- Editing the file by hand is fine too: Studio watches it.

In the game (admins): `/house add <class> <price> [name]` — a house with the door
where you stand, facing as you face; `/house move <id>` — the door here;
`/house del <id>`; `/house free <id>` — takes the house from its owner;
`/house tp <id>` — go to the door; `/house list` — the nearest eight.
Inside a house: `/interior spawn` — players will appear here, facing as you face;
`/interior exit` — the exit point is here.
`/house garage <id>` — the garage point is here (the vehicle you drive, else your
position), facing as you face; `/house garage <id> off` removes it. Inside a garage:
`/garage spawn` and `/garage exit` — the spawn and exit points are here; `/garage slot <n>`
— the place n is here (n = number of slots + 1 adds one).

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

## API

All under `/api` on the Studio's port.

| Route | What |
|---|---|
| `GET /status`, `GET /events` | state of the game files; server-sent events (game loaded, map or houses file changed) |
| `GET/PUT /maps/{name}`, `GET /maps`, `POST /maps/{name}/rename`, `DELETE /maps/{name}` | the maps |
| `GET /catalog?q=&cat=&offset=&limit=` | models: a page `{ total, items }`, ranked by relevance; `q` may be a hash |
| `GET /catalog/categories` | the categories with counts |
| `GET /catalog/{model}`, `GET /models/{file}` | one model's info; its glb |
| `GET /houses`, `PUT /houses` | the houses file with the state of each house (owner); saving it (checked, atomic) |
| `GET /interiors/geometry?x=&y=&z=&r=` | the game's interior (MLO) around a point: room meshes and door portals |
| `GET /roads/nearest?x=&y=&z=&r=` | the game's vehicle path nodes within `r` m (5..200, default 60) of a point: `{ nodes: [{ pos, headings, dist }], suggest: { pos, heading } \| null }`; `suggest` is the nearest node (z + 1) with the heading that keeps the point on the right; 503 while the game loads |
| `GET /vehicles…` | add-on packs (see Vehicles) |

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
| `GoMP.Studio/` | the web server: API (`Api.cs`, `VehiclesApi.cs`, `HousesApi.cs`), events (SSE), the built-in pages |
| `GoMP.Studio.Core/Houses` | the houses file: format, checks, ids, atomic saving |
| `GoMP.Studio.Core/Maps` | the map format, checks, atomic saving |
| `GoMP.Studio.Core/Geometry` | GTA rotations (order 2) ⇄ quaternions, checked against the game |
| `GoMP.Studio.Core/Game` | the game files: catalog, world cells, the archive scan for Linux/macOS |
| `GoMP.Studio.Core/Export` | models → glTF (glb) with PNG textures, cached on disk |
| `GoMP.Studio.Core/Vehicles` | add-on packs: reading, checks, XML edits, writing into the rpf |
| `web/` | the editor (ES modules, three.js 0.170 in `web/vendor/three`) |
| `testdata/` | rotations measured in the game, a small synthetic add-on pack |
