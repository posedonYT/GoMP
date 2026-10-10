# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T12:44:09+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[bots:1000 duration:45s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 14.10 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 21.23 | 33.30 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 100.40 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 2.12 |
| deaths | 3426.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 17.00 |
| heapMB | 267.83 |
| hitsPerSec | 347.38 |
| hostCommandsPerSec | 152.33 |
| hostEventsPerSec | 76.12 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 64.28 |
| players | 1000.00 |
| rssMB | 511.88 |
| shotsPerSec | 603.73 |
| syncDeferredPerSec | 0.00 |
| syncInPerSec | 27657.86 |
| syncOutPerSec | 1495328.22 |
| tickMaxMs | 21.23 |
| tickP50Ms | 7.08 |
| tickP99Ms | 14.10 |
| vehicles | 200.00 |
| violations | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1166.34 |
| ped_p50 | 67.10 |
| ped_p95 | 69.70 |
| ped_p99 | 100.40 |
| samples | 8360980.00 |
| veh_p50 | 66.60 |
| veh_p99 | 75.20 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 18.76 |
| resends | 16.00 |
| syncMsgsPerBotPerSec | 1757.54 |
