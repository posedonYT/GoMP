# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T17:08:41+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:5m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.64 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 5.81 | 33.30 | ✅ |
| script host silence max ms | 1035.91 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 67.90 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.53 |
| deaths | 5304.00 |
| gcPauseP99Ms | 0.52 |
| goroutines | 23.00 |
| heapMB | 84.50 |
| hitsPerSec | 79.61 |
| hostCommandsPerSec | 35.32 |
| hostEventsPerSec | 17.67 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2556.42 |
| hostSilenceMaxMs | 1035.91 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 120.63 |
| players | 200.00 |
| relBacklogMax | 13.00 |
| rssMB | 123.78 |
| shotsPerSec | 134.96 |
| syncDeferredPerSec | 28710.61 |
| syncInPerSec | 5451.63 |
| syncOutPerSec | 574480.70 |
| tickMaxMs | 5.81 |
| tickP50Ms | 2.06 |
| tickP99Ms | 3.64 |
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
| flush avg | 0.16 |
| flush max | 2.91 |
| hosts avg | 0.04 |
| hosts max | 1.50 |
| inbound avg | 0.11 |
| inbound max | 1.57 |
| scripts avg | 0.03 |
| scripts max | 0.73 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.33 |
| streaming max | 3.39 |
| sync avg | 0.24 |
| sync max | 3.10 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1134.24 |
| ped_p50 | 67.10 |
| ped_p95 | 67.70 |
| ped_p99 | 67.90 |
| samples | 21415077.00 |
| veh_p50 | 67.10 |
| veh_p99 | 67.90 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 5.63 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2937.29 |
