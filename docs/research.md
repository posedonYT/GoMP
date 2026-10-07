# Анализ мультиплеерных платформ GTA V: RAGE.MP, FiveM, alt:V

Документ фиксирует, что известно о существующих платформах и какие решения GoMP из этого берёт.
Источники перечислены в конце.

## 1. RAGE Multiplayer (RAGE.MP)

**Устройство**
- Закрытый сервер (`ragemp-server`) и закрытый клиент, который внедряется в GTA V (Legacy).
- Порты по умолчанию: `22005/UDP` — игровой трафик, `22006/TCP` — HTTP-раздача `client_packages` (fastdl).
- Конфигурация — `conf.json` (`maxplayers`, `name`, `gamemode`, `stream-distance`, `bind`, `port`,
  `encryption`, `sync-rate`, `enable-nodejs`, `csharp`, `fastdl-host`, `voice-chat`, …).

**Скриптинг**
- Сервер: Node.js. Каждая папка `packages/<name>/index.js` подключается через `require`, глобальный объект `mp`.
  Доступен весь npm (mysql2, bcrypt, mongoose …) — это ключевая причина популярности RAGE у RP-проектов.
- Клиент: `client_packages/index.js` исполняется во встроенном V8 внутри игры, UI делают на CEF (`mp.browsers`).
- C#: отдельный bridge (`GTANetworkAPI`, атрибуты `[ServerEvent]`, `[Command]`, `[RemoteEvent]`).

**Серверный API (полностью выгружен из ragemp-types)**
- Пулы: `mp.players`, `mp.vehicles`, `mp.objects`, `mp.peds`, `mp.blips`, `mp.markers`, `mp.checkpoints`,
  `mp.colshapes`, `mp.labels`, `mp.dummies`; методы `at/exists/forEach/forEachInRange/forEachInDimension/
  getClosest/toArray/new`.
- `mp.events.add/remove/call/addCommand/addProc/getAllOf/reset`, флаги `delayInitialization/delayShutdown`.
- Сущности: `id/type/model/position/dimension/alpha`, `setVariable/getVariable/setOwnVariable`, `data`.
- `PlayerMp`: `health/armour/heading/name/weapon/vehicle/seat/ping/packetLoss/ip/serial/socialClub`, флаги
  `isAiming/isJumping/isReloading/...`, методы `spawn/call/callProc/giveWeapon/putIntoVehicle/kick/ban/
  outputChatBox/notify/setClothes/setHeadBlend/playAnimation/invoke/eval`.
- `VehicleMp`: `engine/locked/dead/bodyHealth/engineHealth/numberPlate/controller/velocity/steerAngle/...`,
  `setColor/setColorRGB/setMod/repair/explode/getOccupants`.
- 31 серверное событие: `playerJoin`, `playerReady`, `playerQuit`, `playerChat`, `playerCommand`,
  `playerDeath`, `playerDamage`, `playerSpawn`, `playerEnterVehicle`, `playerExitVehicle`,
  `playerStartEnterVehicle`, `playerStartExitVehicle`, `playerWeaponChange`, `playerEnterColshape`,
  `playerExitColshape`, `playerEnterCheckpoint`, `playerExitCheckpoint`, `playerStreamIn/Out`,
  `vehicleDeath`, `vehicleDamage`, `vehicleHornToggle`, `vehicleSirenToggle`, `trailerAttached`,
  `entityCreated`, `entityModelChange`, `incomingConnection`, `packagesLoaded`, `serverShutdown`, …

**Синхронизация**
- Клиент авторитетен для своего педа; водитель — для своей машины; незанятые машины синхронизирует
  «controller» (`vehicle.controller`) — обычно ближайший игрок.
- Сервер ретранслирует состояние игрокам в радиусе `stream-distance` и в том же `dimension`.
- Урон считает игра на стороне клиента (защиты от godmode/чит-урона на уровне платформы нет).
- Shared data (`setVariable`) реплицируется всем, у кого сущность застримлена.

## 2. FiveM (Cfx.re)

- Клиент и сервер (FXServer) открыты на GitHub (но лицензия ограничительная), ресурсы на Lua/JS/C#.
- **OneSync**: собственная синхронизация поверх кода GTA Online. Сущности принадлежат клиентам
  (ownership + миграция), сервер разбирает и пересылает «sync trees» (узлы состояния сущностей).
- **State bags** — реплицируемые key/value на сущностях и глобально (аналог `setVariable`).
- **Routing buckets** — аналог dimensions, каждый bucket имеет свою «сетку» для владения популяцией.
- Популяцию (NPC/трафик) можно отключить на сервере (`SetRoutingBucketPopulationEnabled`).
- Встроенного RPC нет, событиями (`TriggerClientEvent`) пользуются вручную.
- Документация FiveM прямо описывает отличия от «других платформ» (dimensions → buckets,
  setVariable → state bags), что подтверждает: модель RAGE проще для скриптеров.

## 3. alt:V

- Закрытое ядро сервера и клиента, но **модули скриптинга открыты** (`altv-js-module` на Node.js/V8,
  `coreclr-module` для C#), подключаются к ядру через C++ SDK.
- Ресурсы описываются `resource.toml` (server/client main, тип модуля).
- Синхронизирует одежду, внешность, анимации, задачи, урон машин; заявлено 600+ игроков в тестах
  и лимит до 4000 слотов.
- Ключевая идея, которую берёт GoMP: **ядро не знает о языке скриптов**, языковые рантаймы —
  отдельные модули поверх стабильного API.

## 4. Общий вывод: клиент

Клиенты всех трёх платформ закрыты и общаются только со своими серверами по проприетарным
(шифрованным) протоколам. Подключить клиент RAGE.MP к стороннему серверу можно лишь
реверс-инжинирингом, что нарушает их условия использования. Поэтому GoMP поставляет **собственный
клиент**: C++ ASI-плагин на ScriptHookV (GTA V Legacy, сюжетный режим), и собственный открытый
протокол (`docs/protocol.md`).

## 5. Что GoMP берёт у каждой платформы

| Идея | Откуда | Как в GoMP |
|---|---|---|
| Node.js + npm для серверных модов, `packages/`, `mp.*` | RAGE.MP | `runtimes/node` — RAGE-совместимый хост в отдельном процессе |
| Языковые рантаймы как модули поверх ядра | alt:V | IPC-протокол `hostbridge`: Node сейчас, .NET на этапе 3 |
| Клиент-авторитетное движение + controller для пустых машин | RAGE.MP | `core/internal/sync` |
| Dimensions | RAGE.MP / buckets FiveM | `world` + отдельная spatial-сетка на каждое измерение |
| Shared data / state bags | RAGE.MP / FiveM | `setVariable` → `MsgSharedData` по стримингу |
| Отключение популяции | FiveM OneSync | клиент обнуляет плотность NPC/трафика каждый кадр и удаляет чужие сущности |
| Серверный урон | (нет ни у кого из коробки) | `core/internal/combat`: сервер валидирует попадание и хранит HP |

## Источники

- [ragempcommunity/ragemp-types — серверный API RAGE.MP](https://github.com/ragempcommunity/ragemp-types)
- [RAGE.MP wiki: Getting Started with Events](https://wiki.rage.mp/wiki/Getting_Started_with_Events)
- [RAGE.MP wiki: Server settings](https://wiki.rage.mp/wiki/Server_settings)
- [Порты RAGE.MP / alt:V](https://www.kernelhost.com/en/blog/protect-a-ragemp-or-altv-server-from-ddos)
- [FiveM: OneSync](https://docs.fivem.net/docs/scripting-reference/onesync/)
- [FiveM: Migrating from other platforms](https://docs.fivem.net/docs/scripting-manual/migrating-from-other-platforms/)
- [FiveM: Routing buckets](https://docs.fivem.net/docs/cookbook/2020/11/27/routing-buckets-split-game-state/)
- [alt:V JS module setup](https://docs.altv.mp/js/articles/setup.html), [altmp на GitHub](https://github.com/altmp)
- [Отключение NPC/трафика нативками](https://forum.cfx.re/t/release-disable-vehicles-and-peds/916)
