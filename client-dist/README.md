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

## Houses and the phone

Houses (house blips: green for sale, blue the own one) come in three classes,
each with its interior and garage: Эконом (the low-end apartment, 2 places),
Комфорт (the medium apartment, 6) and Люкс (4 Integrity Way, 10). At the door
"E" opens the house: buy it for cash or by card (one per character), look
inside, enter, lock the door or sell it back for half the price. The owner
drives a vehicle up to the house and puts it into the garage with "E"; taken
out, it stands on the nearest road and goes back into the garage when the
owner leaves the game. Admins add, move and remove houses with `/house`
(`server-files/packages/freeroam/houses.js`).

The up arrow takes out the phone (a phone must be in the inventory; it is sold
in 24/7 shops): contacts, messages (also to players who are offline), the bank
(balance, transfers by phone number, the card statement), the house and its
garage, map routes and settings (wallpaper, sounds). The app icons
(`gomp/icons/app_*.png`) are drawn by `tools/icons/phone-icons.ps1`.

`GOMP_PROBE=houses KEEP=1 tools/addons/testpack.sh` checks the house places: the
client goes from the login screen through every interior and door and logs
`probe:` lines to `gomp.log` (an interior must load, a door must be outside on
the ground).
