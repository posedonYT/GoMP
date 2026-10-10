# GoMP — ядро GTA V RP-сервера на Go, совместимое с модами RAGE.MP

Структура (ядро изолировано от модов, см. `core/arch_test.go`):

| Папка | Что внутри |
|---|---|
| `core/` | Ядро сервера (`core/internal/*` недоступно извне): мир, стриминг, синхронизация, урон, античит, мост к скриптам, админка |
| `wire/` | Публичный протокол: кодек сообщений и reliable-UDP транспорт (+ шифрование) |
| `runtimes/node/` | RAGE.MP-совместимый рантайм `mp.*` (Node.js, отдельный процесс) |
| `server-files/` | Раскладка как у RAGE.MP: `conf.json`, `packages/freeroam`, `client_packages/` |
| `tools/` | Go-боты, стресс-тест, генератор нативок |
| `tools/studio/` | GoMP Studio — 3D-редактор карты сервера и кастомных машин (Windows/Linux/macOS), см. `tools/studio/README.md` |
| `client/` | C++ клиент: `core` (протокол/транспорт), `headless`, `game` (ASI, в работе) |
| `docs/` | `research.md` — анализ RAGE.MP / FiveM / alt:V; `performance.md` — нагрузка, настройки, Redis, метрики |

## Запуск

```bash
make build
```

```bash
make run
```

```bash
make test
```

```bash
make stress
```

## Производительность

Настройки под нагрузку (`max-reliable-backlog`, `max-packets-per-second`, `host-ops-per-tick`,
`host-mirror-rate`), хранилище геймода (файлы по умолчанию или Redis через `storage` /
`GOMP_REDIS_URL`), метрики и стресс-тест — в [docs/performance.md](docs/performance.md).

## Статус (этап 1)

Готово и проверено тестами:
- Go-ядро, транспорт, протокол, античит, серверный урон — `go test -race ./...`
- Node.js-рантайм `mp.*` — `node --test`, сквозные тесты с реальным Node и RAGE-модом
- C++ ядро клиента — совместимость байт-в-байт с Go (golden + крипто-вектор), `client/headless` проходит E2E против сервера
- Стресс 1000 ботов (mixed/hotspot/uniform/плохая сеть, перезапуск Node): тик p99 ≤ 9 мс при бюджете 33 мс

Не завершено:
- `client/game` (ASI для ScriptHookV): написаны `shv.*`, `main.cpp`, `config.cpp`, `game_client.*`, `local_player.cpp`;
  нет `remote.cpp` (удалённые игроки/машины), UI/подавления NPC, сгенерированного `natives.hpp`, CMake-сборки.
  Не компилировался и не проверялся в игре.
- `docs/architecture.md`, `docs/protocol.md`, `docs/compat-matrix.md`.
- Этапы 2 (client_packages) и 3 (C#).
