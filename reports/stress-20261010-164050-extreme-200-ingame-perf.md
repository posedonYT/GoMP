# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:40:50+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.11 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 13.26 | 33.30 | ✅ |
| script host silence max ms | 1036.17 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.46 |
| deaths | 5329.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 23.00 |
| heapMB | 79.53 |
| hitsPerSec | 80.14 |
| hostCommandsPerSec | 35.46 |
| hostEventsPerSec | 17.76 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2551.68 |
| hostSilenceMaxMs | 1036.17 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 121.29 |
| players | 200.00 |
| relBacklogMax | 53.00 |
| rssMB | 124.99 |
| shotsPerSec | 135.25 |
| syncDeferredPerSec | 31281.06 |
| syncInPerSec | 5450.59 |
| syncOutPerSec | 576349.60 |
| tickMaxMs | 13.26 |
| tickP50Ms | 1.58 |
| tickP99Ms | 3.11 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 2.61 |
| flush avg | 0.15 |
| flush max | 4.81 |
| hosts avg | 0.03 |
| hosts max | 1.16 |
| inbound avg | 0.09 |
| inbound max | 3.51 |
| scripts avg | 0.02 |
| scripts max | 0.67 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.30 |
| streaming max | 4.70 |
| sync avg | 0.27 |
| sync max | 6.70 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 108557.70 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 68.00 |
| samples | 21476381.00 |
| veh_p50 | 67.10 |
| veh_p99 | 67.90 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.56 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2946.42 |
