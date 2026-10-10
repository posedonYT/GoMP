# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T13:09:29+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[bots:1000 duration:30s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 12.75 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 19.00 | 33.30 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 99.90 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.99 |
| deaths | 2280.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 23.00 |
| heapMB | 428.78 |
| hitsPerSec | 345.70 |
| hostCommandsPerSec | 150.97 |
| hostEventsPerSec | 75.75 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 12913.22 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 63.08 |
| players | 1000.00 |
| relBacklogMax | 125.00 |
| rssMB | 495.38 |
| shotsPerSec | 603.69 |
| syncDeferredPerSec | 0.10 |
| syncInPerSec | 27656.50 |
| syncOutPerSec | 1468819.88 |
| tickMaxMs | 19.00 |
| tickP50Ms | 5.71 |
| tickP99Ms | 12.75 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 200.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1136.86 |
| ped_p50 | 67.10 |
| ped_p95 | 69.90 |
| ped_p99 | 99.90 |
| samples | 5493209.00 |
| veh_p50 | 66.50 |
| veh_p99 | 73.30 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 21.14 |
| resends | 13.00 |
| syncMsgsPerBotPerSec | 1864.04 |
