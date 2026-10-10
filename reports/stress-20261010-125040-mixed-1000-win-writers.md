# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T12:50:40+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[bots:1000 duration:45s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 14.01 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 18.75 | 33.30 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 100.10 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 2.06 |
| deaths | 3438.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 260.32 |
| hitsPerSec | 346.92 |
| hostCommandsPerSec | 152.60 |
| hostEventsPerSec | 76.23 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 33608.95 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 63.98 |
| players | 1000.00 |
| relBacklogMax | 172.00 |
| rssMB | 510.70 |
| shotsPerSec | 603.51 |
| syncDeferredPerSec | 0.09 |
| syncInPerSec | 27638.02 |
| syncOutPerSec | 1495936.18 |
| tickMaxMs | 18.75 |
| tickP50Ms | 7.16 |
| tickP99Ms | 14.01 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 200.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1169.42 |
| ped_p50 | 67.10 |
| ped_p95 | 69.60 |
| ped_p99 | 100.10 |
| samples | 8381513.00 |
| veh_p50 | 66.60 |
| veh_p99 | 71.20 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 19.56 |
| resends | 19.00 |
| syncMsgsPerBotPerSec | 1752.81 |
