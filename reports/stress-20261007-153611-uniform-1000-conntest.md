# Стресс-тест GoMP: 1000 ботов, профиль uniform

- Дата: 2026-10-07T15:36:11+03:00
- Машина: map[arch:arm64 cpus:10 go:go1.27.1 os:darwin]
- Параметры: map[bots:1000 duration:5s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:uniform]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 5.36 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 5.57 | 33.30 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 72.50 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.87 |
| deaths | 11.00 |
| gcPauseP99Ms | 0.11 |
| goroutines | 17.00 |
| heapMB | 288.45 |
| hitsPerSec | 8.04 |
| hostCommandsPerSec | 8.24 |
| hostEventsPerSec | 2.16 |
| kbInPerPlayerSec | 1.27 |
| kbOutPerPlayerSec | 3.65 |
| players | 1000.00 |
| rssMB | 370.91 |
| shotsPerSec | 14.90 |
| syncDeferredPerSec | 0.00 |
| syncInPerSec | 29897.83 |
| syncOutPerSec | 92289.70 |
| tickMaxMs | 5.57 |
| tickP50Ms | 2.19 |
| tickP99Ms | 5.36 |
| vehicles | 200.00 |
| violations | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1106.25 |
| ped_p50 | 66.50 |
| ped_p95 | 70.80 |
| ped_p99 | 72.50 |
| samples | 54987.00 |
| veh_p50 | 66.10 |
| veh_p99 | 72.80 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 31.49 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 191.42 |
