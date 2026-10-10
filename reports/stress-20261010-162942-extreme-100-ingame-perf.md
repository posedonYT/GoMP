# Стресс-тест GoMP: 100 ботов, профиль extreme

- Дата: 2026-10-10T16:29:42+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:100 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 1.05 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 395.05 | 33.30 | ❌ |
| script host silence max ms | 1034.09 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 100.00 | 100.00 | ✅ |
| ped sync latency p99 ms | 67.90 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.16 |
| deaths | 2650.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 24.96 |
| hitsPerSec | 39.76 |
| hostCommandsPerSec | 17.66 |
| hostEventsPerSec | 8.84 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 1296.44 |
| hostSilenceMaxMs | 1034.09 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.29 |
| kbOutPerPlayerSec | 74.48 |
| players | 100.00 |
| relBacklogMax | 4.00 |
| rssMB | 69.92 |
| shotsPerSec | 67.67 |
| syncDeferredPerSec | 0.00 |
| syncInPerSec | 2698.17 |
| syncOutPerSec | 179465.84 |
| tickMaxMs | 395.05 |
| tickP50Ms | 0.00 |
| tickP99Ms | 1.05 |
| ticksMissed | 11.00 |
| ticksOver | 1.00 |
| vehicles | 20.00 |
| violations | 1286.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.03 |
| controllers max | 1.62 |
| flush avg | 0.16 |
| flush max | 2.00 |
| hosts avg | 0.04 |
| hosts max | 1.01 |
| inbound avg | 0.05 |
| inbound max | 389.99 |
| scripts avg | 0.00 |
| scripts max | 3.01 |
| shapes avg | 0.00 |
| shapes max | 0.50 |
| streaming avg | 0.04 |
| streaming max | 2.51 |
| sync avg | 0.09 |
| sync max | 2.54 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 94696.28 |
| ped_p50 | 67.20 |
| ped_p95 | 67.80 |
| ped_p99 | 67.90 |
| samples | 6673193.00 |
| veh_p50 | 67.10 |
| veh_p99 | 67.90 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 25.24 |
| resends | 19.00 |
| syncMsgsPerBotPerSec | 1827.43 |
