# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:13:02+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.12 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 11.69 | 33.30 | ✅ |
| script host silence max ms | 1035.13 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.10 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.45 |
| deaths | 5338.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 54.53 |
| hitsPerSec | 80.05 |
| hostCommandsPerSec | 35.59 |
| hostEventsPerSec | 17.79 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2556.93 |
| hostSilenceMaxMs | 1035.13 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 121.10 |
| players | 200.00 |
| relBacklogMax | 14.00 |
| rssMB | 124.35 |
| shotsPerSec | 135.44 |
| syncDeferredPerSec | 33602.02 |
| syncInPerSec | 5448.91 |
| syncOutPerSec | 578552.63 |
| tickMaxMs | 11.69 |
| tickP50Ms | 1.60 |
| tickP99Ms | 3.12 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 3.82 |
| flush avg | 0.14 |
| flush max | 3.71 |
| hosts avg | 0.03 |
| hosts max | 0.74 |
| inbound avg | 0.08 |
| inbound max | 2.07 |
| scripts avg | 0.02 |
| scripts max | 1.01 |
| shapes avg | 0.00 |
| shapes max | 0.65 |
| streaming avg | 1.30 |
| streaming max | 7.56 |
| sync avg | 0.28 |
| sync max | 2.74 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 112725.48 |
| ped_p50 | 67.10 |
| ped_p95 | 67.80 |
| ped_p99 | 68.10 |
| samples | 21564287.00 |
| veh_p50 | 67.10 |
| veh_p99 | 68.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 3.92 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2959.02 |
