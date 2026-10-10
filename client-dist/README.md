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

## Add-on vehicles

`addons/<pack>/dlc.rpf` are add-on vehicle packs from gta5-mods.com (personal
use only, do not redistribute): `cullinan_kpym` (Kpym's Rolls-Royce Cullinan),
`bvss` (Bugatti Veyron 16.4 Super Sport), `agerars` (le__AK's 2017 Koenigsegg
Agera RS 1.2), `krga` and `jesko` (Hammer76's Koenigsegg Regera 2.0 and Jesko
Absolut 3.0, the Legacy builds), `lada2107` (DragoN777's VAZ-2107 1.3), `m5`
(Alex9581 & p4elkin's 2012 BMW M5 F10 1.1), `20audirs7c8` (ahmeda1999's 2020
Audi RS7 Sportback C8, badged) and `g37s` (Ubludock's 2008 Infiniti G37 Coupe Sport
1.0, a replacement of `felon2` turned into an add-on pack: its model files renamed and
packed with `gomp-addons pack`, with the Felon GT's data, handling and sound).
Ids that could clash with the game's own were renumbered in `carcols.meta` and `carvariations.meta`: the mod kits of
`lada2107` (950 → 2107) and `m5` (1270 → 2012, with its light settings), and the
light settings of `20audirs7c8` (1, which is the game's own, → 2783). The
downloaded archives are in `addons-src`. `RageOpenV.asi`
(https://github.com/Chiheb-Bacha/RageOpenV, do not redistribute) makes the game
read `<game>\mods` during GoMP sessions.

Before each session the launcher runs `bin\addons\gomp-addons.exe install`
(`tools/addons`, built on CodeWalker.Core). It copies the packs into
`<game>\mods\update\x64\dlcpacks` and keeps `<game>\mods\update\update.rpf` up to
date: a copy of the game's archive with the packs in `dlclist.xml` and
`MaxExtraVehicleModelInfos` raised from 640 to 1024 in `gameconfig.xml`. Game
build 3889 and its DLCs use 637 of those 640 vehicle model infos, so without
the raise the fourth add-on vehicle overflows the pool and the game crashes
while loading (GTA5.exe+0x6057e1). `tools/addons/testpack.sh` starts a session
and reports whether the game loads with the packs of `addons`.

Spawn them with `/veh vaz2107`, `/veh m5`, `/veh rs7`, `/veh g37s`, `/veh agera`, `/veh regera`, `/veh jesko`,
`/veh veyron` and `/veh cullinan`; an admin gives one with `/give [static] vaz2107`
(aliases: `server-files/packages/freeroam/vehicles.js`). Los Santos Customs (the
spray-can blips) tunes the own vehicle: at the workshop door the vehicle is moved
into the bay inside, where it can be looked over from every side (views, open
bonnet, boot and doors, the cabin); the parts of its mod kit, paint, wheels,
neon, xenon, turbo, tint and plates can be bought, and the tuning is saved per
character and model.

## Car dealership, own cars, organizations

**Dealership.** Premium Deluxe Motorsport (the car blip downtown): "E" at the
counter opens the catalog. Two sections: «Кастомные» (the add-on packs) and
«Игровые» (the game's cars). Each section is split by class: compacts, sedans,
SUVs… The chosen car stands on the showroom floor in the colour picked. It is
bought for cash or by card and waits on the parking lot outside, with a
waypoint to it.

The catalog is `server-files/dealership.json`. Prices can be edited by hand.
`node tools/dealership/generate.js http://127.0.0.1:22100` rebuilds the list
from GoMP Studio; prices edited by hand are kept.

**Own cars.** A character has up to 10 cars. They are listed in F2 →
«Недвижимость» together with the house:
- «Вызвать» — the car comes to the road next to you;
- «Метка» — the car is marked on the map;
- «На парковку» — the car is sent back to the parking.

A car on the street goes back to the parking when its owner leaves the game. A
car can also be kept in the garage of one's house.

`/veh <model>` gives a vehicle that belongs to nobody: anyone opens, locks,
starts, belts up in and refuels it.

**Organizations.** There are four: LSPD, Army, EMS and GOV. Each has a base in a
real interior of the map; you walk in, there is no teleport and no other
dimension:
- LSPD — Mission Row Police Station;
- Army — the Fort Zancudo tower;
- EMS — the Davis fire & medical station;
- GOV — the main hall of the Pacific Standard bank.

At every base there are a storage and work vehicles:
- **Storage.** Members get a marker and "E". The storage opens next to the
  inventory; items are dragged in and out. Every member can put items in;
  taking them needs the permission.
- **Work vehicles.** They stand locked next to the base, and members unlock
  them with L. A wrecked vehicle is replaced; one left away from its place goes
  back after 10 minutes.

Commands:
- `/invite <static>` — invites a player; he gets a window to accept;
- `/uninvite <static>` — dismisses a member;
- `/setrank <static> <rank>` — changes a member's rank;
- `/org` — information about your organization.

The leader sets the permissions of each rank (invite, dismiss, change ranks,
take from the storage, work vehicles) and renames ranks in F2 → «Организация».
Members are promoted, demoted and dismissed there with + / − / x.

The bases, doors, storage points, vehicles and rank names are in
`server-files/organizations.json`. Members, rank settings and the storages are
kept in the database.

**Admin commands** (in addition to `/ahelp`):
- `/invis` — invisibility: no ped, name tag or blip for others;
- `/fly` — flight: W/S/A/D, Space up, Ctrl down, Shift faster; the core's
  movement checks are off meanwhile;
- `/tpm` — teleport to the map waypoint;
- `/makeleader <static> <lspd|army|ems|gov|none>` — appoints or removes a leader;
- `/setorg <static> <org|none> [rank]` — puts a player into an organization.

`/give <static> <car>` now gives a car of one's own (it appears in F2).

## Houses and the phone

Houses (house blips: green for sale, blue the own one) come in three classes,
each with its interior and garage: Эконом (the low-end apartment, 2 places),
Комфорт (the medium apartment, 6) and Люкс (4 Integrity Way, 10). At the door
"E" opens the house: buy it for cash or by card (one per character), look
inside, enter, lock the door or sell it back for half the price. The owner
drives a vehicle up to the house and puts it into the garage with "E"; taken
out, it stands on the nearest road and goes back into the garage when the
owner leaves the game. Admins add, move and remove houses with `/house`
(`server-files/packages/freeroam/houses.js`); the definitions are in `server-files/houses.json`, edited with GoMP Studio (the Дома tab, see `tools/studio/README.md`).

The up arrow takes out the phone (a phone must be in the inventory; it is sold
in 24/7 shops): contacts, messages (also to players who are offline), the bank
(balance, transfers by phone number, the card statement), the house and its
garage, map routes and settings (wallpaper, sounds). The app icons
(`gomp/icons/app_*.png`) are drawn by `tools/icons/phone-icons.ps1`.

**Garages.** A class or house can have a garage interior (a real room, in a
dimension of its own) and a garage point, the entry outside. Only the owner
uses it. Ways in: «В гараж» in the house window; the exit menu «На улицу /
В гараж» when leaving the house; or by car: drive slowly onto the purple garage
point (marker and the «Мой гараж» blip within 30 m), press "E" at «Заехать в
гараж» and the car takes its place with you in it. In the garage on foot the
exit marker asks «На улицу / В дом». To leave by car sit at the wheel of any car
in the garage and press "E": it comes out at the garage point, facing the way set
there. While the owner is inside, every car stored in the house stands on its
slot; when he leaves they go back into the garage. A house with no garage
interior keeps the old garage (the door, "E", the road).

After choosing a character the spawn screen offers «Там, где вышел» and, when the
character owns a house, «Дом» (otherwise only the first option). New characters
appear as before.

`GOMP_PROBE=houses KEEP=1 tools/addons/testpack.sh` checks the house places: the
client goes from the login screen through every interior and door and logs
`probe:` lines to `gomp.log` (an interior must load, a door must be outside on
the ground). `GOMP_PROBE=garages` tours only the garages (`houses` does both);
add `,ui` (`garages,ui`) for the screenshot steps (`probe-ui:` lines: each garage
full of test cars, the exit menu, the spawn screen). Lines:

```
probe: garage <id> spawn x y z: interior <i> ready <0|1> ground <z|none>
probe: garage <id> exit x y z: interior <i> ground <z|none> dist-from-spawn <m>
probe: garage <id> slot <n> x y z h <deg>: interior <i> ground <z|none> car dz <m> tilt <deg> moved <m>
probe: garagepoint #<id> x y z h <deg>: interior <i> ground <z|none> road <m> car dz <m> tilt <deg> moved <m>
```

Expected: a garage spawn has interior not 0, ready 1 and ground near -100; at a
slot the test car has moved < 0.5, tilt < 5 and dz between -0.8 and +0.2; a garage
point has interior 0, ground within 1 m of z - 1 and a car that settles. Seed points
that need a look in Studio after a probe: houses 1-5, 8, 9 and 1001.

`GOMP_PROBE=perf` measures the client: once spawned it stays 60 s and the
`perf ...` / `perf parts_ms ...` lines (fps, tick cost and its parts) go to `gomp.log`
between `probe: perf start` and `probe: done` (see docs/performance.md).

Manual check list (needs a login, so by hand): buy an Эконом house; drive in at the
garage point; get out and walk to the exit; «В дом»; at the house exit marker
«В гараж»; get into the car and press "E": you appear at the garage point; quit
inside the garage; log in: «Там, где вышел» puts you at the door; log in again and
choose «Дом».
