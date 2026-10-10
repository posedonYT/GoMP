# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T15:40:19+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:true bots:1000 duration:45s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 12.45 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 19.12 | 33.30 | ✅ |
| script host silence max ms | 1038.20 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 99.40 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.94 |
| deaths | 3464.00 |
| gcPauseP99Ms | 0.79 |
| goroutines | 23.00 |
| heapMB | 333.60 |
| hitsPerSec | 350.18 |
| hostCommandsPerSec | 153.88 |
| hostEventsPerSec | 76.81 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 12955.34 |
| hostSilenceMaxMs | 1038.20 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 63.08 |
| players | 1000.00 |
| relBacklogMax | 166.00 |
| rssMB | 501.22 |
| shotsPerSec | 607.53 |
| syncDeferredPerSec | 0.07 |
| syncInPerSec | 27618.02 |
| syncOutPerSec | 1463420.36 |
| tickMaxMs | 19.12 |
| tickP50Ms | 5.83 |
| tickP99Ms | 12.45 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 200.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.21 |
| controllers max | 10.82 |
| flush avg | 0.56 |
| flush max | 3.27 |
| hosts avg | 0.20 |
| hosts max | 4.66 |
| inbound avg | 1.67 |
| inbound max | 6.44 |
| scripts avg | 0.21 |
| scripts max | 2.12 |
| shapes avg | 0.00 |
| shapes max | 0.00 |
| streaming avg | 2.13 |
| streaming max | 6.47 |
| sync avg | 1.11 |
| sync max | 4.56 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1136.26 |
| ped_p50 | 67.10 |
| ped_p95 | 69.70 |
| ped_p99 | 99.40 |
| samples | 8198205.00 |
| veh_p50 | 66.50 |
| veh_p99 | 73.30 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 20.96 |
| resends | 10.00 |
| syncMsgsPerBotPerSec | 1714.67 |
