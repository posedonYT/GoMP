# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:51:58+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=80,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 2.67 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 6.29 | 33.30 | ✅ |
| script host silence max ms | 1035.43 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.42 |
| deaths | 5452.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 78.08 |
| hitsPerSec | 81.71 |
| hostCommandsPerSec | 36.33 |
| hostEventsPerSec | 18.17 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2147.17 |
| hostSilenceMaxMs | 1035.43 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.24 |
| kbOutPerPlayerSec | 114.06 |
| players | 200.00 |
| relBacklogMax | 9.00 |
| rssMB | 122.95 |
| shotsPerSec | 137.63 |
| syncDeferredPerSec | 2591.37 |
| syncInPerSec | 5437.62 |
| syncOutPerSec | 575887.86 |
| tickMaxMs | 6.29 |
| tickP50Ms | 1.55 |
| tickP99Ms | 2.67 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 0.00 |
| violations | 1292.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 2.62 |
| flush avg | 0.21 |
| flush max | 3.51 |
| hosts avg | 0.03 |
| hosts max | 1.46 |
| inbound avg | 0.09 |
| inbound max | 2.10 |
| scripts avg | 0.03 |
| scripts max | 0.69 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.21 |
| streaming max | 4.23 |
| sync avg | 0.24 |
| sync max | 2.51 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 94307.11 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 68.00 |
| samples | 21505538.00 |
| veh_p50 | 0.00 |
| veh_p99 | 0.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.35 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2950.62 |
