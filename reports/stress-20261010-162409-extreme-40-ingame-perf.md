# Стресс-тест GoMP: 40 ботов, профиль extreme

- Дата: 2026-10-10T16:24:09+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:40 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 0.00 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 1.10 | 33.30 | ✅ |
| script host silence max ms | 1033.72 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 40.00 | 40.00 | ✅ |
| ped sync latency p99 ms | 67.80 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.04 |
| deaths | 1047.00 |
| gcPauseP99Ms | 0.00 |
| goroutines | 23.00 |
| heapMB | 15.79 |
| hitsPerSec | 15.79 |
| hostCommandsPerSec | 6.98 |
| hostEventsPerSec | 3.50 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 534.47 |
| hostSilenceMaxMs | 1033.72 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 29.93 |
| players | 40.00 |
| relBacklogMax | 0.00 |
| rssMB | 39.94 |
| shotsPerSec | 26.98 |
| syncDeferredPerSec | 0.00 |
| syncInPerSec | 1092.72 |
| syncOutPerSec | 28786.43 |
| tickMaxMs | 1.10 |
| tickP50Ms | 0.00 |
| tickP99Ms | 0.00 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 8.00 |
| violations | 1441.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.00 |
| controllers max | 0.60 |
| flush avg | 0.00 |
| flush max | 0.62 |
| hosts avg | 0.00 |
| hosts max | 0.60 |
| inbound avg | 0.00 |
| inbound max | 1.08 |
| scripts avg | 0.00 |
| scripts max | 0.00 |
| shapes avg | 0.00 |
| shapes max | 0.00 |
| streaming avg | 0.00 |
| streaming max | 0.52 |
| sync avg | 0.00 |
| sync max | 0.69 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 98190.24 |
| ped_p50 | 66.80 |
| ped_p95 | 67.50 |
| ped_p99 | 67.80 |
| samples | 1064347.00 |
| veh_p50 | 66.80 |
| veh_p99 | 67.80 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 14.40 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 728.48 |
