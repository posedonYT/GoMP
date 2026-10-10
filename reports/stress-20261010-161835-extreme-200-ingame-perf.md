# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T16:18:35+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.17 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 13.00 | 33.30 | ✅ |
| script host silence max ms | 1035.47 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.51 |
| deaths | 5348.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 87.08 |
| hitsPerSec | 80.27 |
| hostCommandsPerSec | 35.64 |
| hostEventsPerSec | 17.83 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2552.78 |
| hostSilenceMaxMs | 1035.47 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 121.72 |
| players | 200.00 |
| relBacklogMax | 9.00 |
| rssMB | 125.29 |
| shotsPerSec | 135.50 |
| syncDeferredPerSec | 35558.41 |
| syncInPerSec | 5447.59 |
| syncOutPerSec | 579423.71 |
| tickMaxMs | 13.00 |
| tickP50Ms | 1.61 |
| tickP99Ms | 3.17 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 3.13 |
| flush avg | 0.17 |
| flush max | 3.57 |
| hosts avg | 0.03 |
| hosts max | 1.40 |
| inbound avg | 0.09 |
| inbound max | 4.15 |
| scripts avg | 0.03 |
| scripts max | 1.56 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.37 |
| streaming max | 9.69 |
| sync avg | 0.26 |
| sync max | 2.58 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 107967.79 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 68.00 |
| samples | 21594313.00 |
| veh_p50 | 67.20 |
| veh_p99 | 68.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 4.69 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2962.98 |
