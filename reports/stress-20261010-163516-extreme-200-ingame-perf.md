# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:35:16+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.13 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 375.32 | 33.30 | ❌ |
| script host silence max ms | 1067.42 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.41 |
| deaths | 5278.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 23.00 |
| heapMB | 57.02 |
| hitsPerSec | 79.21 |
| hostCommandsPerSec | 35.13 |
| hostEventsPerSec | 17.59 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2535.88 |
| hostSilenceMaxMs | 1067.42 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.30 |
| kbOutPerPlayerSec | 119.56 |
| players | 200.00 |
| relBacklogMax | 11.00 |
| rssMB | 126.27 |
| shotsPerSec | 134.46 |
| syncDeferredPerSec | 28298.69 |
| syncInPerSec | 5404.04 |
| syncOutPerSec | 568617.62 |
| tickMaxMs | 375.32 |
| tickP50Ms | 1.59 |
| tickP99Ms | 3.13 |
| ticksMissed | 24.00 |
| ticksOver | 3.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 2.73 |
| flush avg | 0.22 |
| flush max | 371.89 |
| hosts avg | 0.03 |
| hosts max | 1.29 |
| inbound avg | 0.14 |
| inbound max | 320.67 |
| scripts avg | 0.02 |
| scripts max | 1.04 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.31 |
| streaming max | 252.08 |
| sync avg | 0.29 |
| sync max | 9.03 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 108969.66 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 68.00 |
| samples | 21191278.00 |
| veh_p50 | 67.10 |
| veh_p99 | 68.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.83 |
| resends | 55.00 |
| syncMsgsPerBotPerSec | 2907.47 |
