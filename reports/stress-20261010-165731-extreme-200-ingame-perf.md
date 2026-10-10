# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:57:31+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=80,drivers=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 2.65 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 10.31 | 33.30 | ✅ |
| script host silence max ms | 1035.30 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.10 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.46 |
| deaths | 1.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 85.70 |
| hitsPerSec | 0.00 |
| hostCommandsPerSec | 0.01 |
| hostEventsPerSec | 0.01 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2447.42 |
| hostSilenceMaxMs | 1035.30 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.30 |
| kbOutPerPlayerSec | 113.48 |
| players | 200.00 |
| relBacklogMax | 4.00 |
| rssMB | 117.26 |
| shotsPerSec | 0.00 |
| syncDeferredPerSec | 20423.48 |
| syncInPerSec | 6004.76 |
| syncOutPerSec | 602604.66 |
| tickMaxMs | 10.31 |
| tickP50Ms | 1.55 |
| tickP99Ms | 2.65 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 58.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 3.10 |
| flush avg | 0.23 |
| flush max | 4.12 |
| hosts avg | 0.02 |
| hosts max | 1.51 |
| inbound avg | 0.01 |
| inbound max | 1.59 |
| scripts avg | 0.00 |
| scripts max | 0.63 |
| shapes avg | 0.00 |
| shapes max | 0.00 |
| streaming avg | 1.24 |
| streaming max | 8.28 |
| sync avg | 0.30 |
| sync max | 5.55 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 95710.85 |
| ped_p50 | 67.20 |
| ped_p95 | 67.80 |
| ped_p99 | 68.10 |
| samples | 22539138.00 |
| veh_p50 | 67.20 |
| veh_p99 | 68.10 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.02 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 3093.27 |
