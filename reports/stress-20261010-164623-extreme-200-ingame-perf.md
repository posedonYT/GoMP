# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:46:23+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=100 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 2.60 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 5.71 | 33.30 | ✅ |
| script host silence max ms | 1034.54 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.38 |
| deaths | 0.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 62.30 |
| hitsPerSec | 0.00 |
| hostCommandsPerSec | 0.01 |
| hostEventsPerSec | 0.01 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2041.88 |
| hostSilenceMaxMs | 1034.54 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.23 |
| kbOutPerPlayerSec | 100.76 |
| players | 200.00 |
| relBacklogMax | 4.00 |
| rssMB | 115.12 |
| shotsPerSec | 0.00 |
| syncDeferredPerSec | 196.11 |
| syncInPerSec | 6004.60 |
| syncOutPerSec | 568861.55 |
| tickMaxMs | 5.71 |
| tickP50Ms | 1.08 |
| tickP99Ms | 2.60 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 0.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 3.12 |
| flush avg | 0.16 |
| flush max | 3.04 |
| hosts avg | 0.03 |
| hosts max | 0.78 |
| inbound avg | 0.00 |
| inbound max | 1.52 |
| scripts avg | 0.00 |
| scripts max | 0.52 |
| shapes avg | 0.00 |
| shapes max | 0.56 |
| streaming avg | 1.07 |
| streaming max | 3.63 |
| sync avg | 0.20 |
| sync max | 2.20 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 93967.94 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 68.00 |
| samples | 21311447.00 |
| veh_p50 | 0.00 |
| veh_p99 | 0.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.08 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2924.70 |
