# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T12:39:20+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[bots:1000 duration:45s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 15.07 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 19.19 | 33.30 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 71.10 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.63 |
| deaths | 3410.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 17.00 |
| heapMB | 349.95 |
| hitsPerSec | 345.28 |
| hostCommandsPerSec | 151.31 |
| hostEventsPerSec | 75.61 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 62.70 |
| players | 1000.00 |
| rssMB | 500.55 |
| shotsPerSec | 605.15 |
| syncDeferredPerSec | 0.16 |
| syncInPerSec | 27655.28 |
| syncOutPerSec | 1453359.13 |
| tickMaxMs | 19.19 |
| tickP50Ms | 6.93 |
| tickP99Ms | 15.07 |
| vehicles | 200.00 |
| violations | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1135.35 |
| ped_p50 | 67.00 |
| ped_p95 | 69.30 |
| ped_p99 | 71.10 |
| samples | 8143037.00 |
| veh_p50 | 66.30 |
| veh_p99 | 69.90 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 13.73 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 1710.75 |
