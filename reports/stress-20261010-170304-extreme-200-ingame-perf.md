# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T17:03:04+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.60 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 7.12 | 33.30 | ✅ |
| script host silence max ms | 1035.70 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.10 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.38 |
| deaths | 5321.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 92.68 |
| hitsPerSec | 79.90 |
| hostCommandsPerSec | 35.41 |
| hostEventsPerSec | 17.73 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2543.75 |
| hostSilenceMaxMs | 1035.70 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 121.15 |
| players | 200.00 |
| relBacklogMax | 14.00 |
| rssMB | 123.97 |
| shotsPerSec | 135.18 |
| syncDeferredPerSec | 27966.61 |
| syncInPerSec | 5450.71 |
| syncOutPerSec | 575128.70 |
| tickMaxMs | 7.12 |
| tickP50Ms | 1.63 |
| tickP99Ms | 3.60 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 2.70 |
| flush avg | 0.14 |
| flush max | 2.52 |
| hosts avg | 0.03 |
| hosts max | 1.30 |
| inbound avg | 0.07 |
| inbound max | 1.63 |
| scripts avg | 0.02 |
| scripts max | 2.41 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.28 |
| streaming max | 3.74 |
| sync avg | 0.26 |
| sync max | 2.17 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1134.13 |
| ped_p50 | 67.10 |
| ped_p95 | 67.80 |
| ped_p99 | 68.10 |
| samples | 21437646.00 |
| veh_p50 | 67.20 |
| veh_p99 | 68.10 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 6.45 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2940.37 |
