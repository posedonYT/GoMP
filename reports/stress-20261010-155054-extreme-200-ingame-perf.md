# Стресс-тест GoMP: 200 ботов, профиль extreme

- Дата: 2026-10-10T15:50:54+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:200 duration:7m0s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:extreme]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 3.63 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 18.86 | 33.30 | ✅ |
| script host silence max ms | 1034.97 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 200.00 | 200.00 | ✅ |
| ped sync latency p99 ms | 68.00 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.42 |
| deaths | 7458.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 23.00 |
| heapMB | 94.05 |
| hitsPerSec | 79.82 |
| hostCommandsPerSec | 35.47 |
| hostEventsPerSec | 17.76 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 2549.82 |
| hostSilenceMaxMs | 1034.97 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 120.94 |
| players | 200.00 |
| relBacklogMax | 8.00 |
| rssMB | 126.20 |
| shotsPerSec | 134.99 |
| syncDeferredPerSec | 28818.42 |
| syncInPerSec | 5450.27 |
| syncOutPerSec | 575578.95 |
| tickMaxMs | 18.86 |
| tickP50Ms | 1.64 |
| tickP99Ms | 3.63 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 40.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.04 |
| controllers max | 3.17 |
| flush avg | 0.15 |
| flush max | 3.42 |
| hosts avg | 0.03 |
| hosts max | 1.41 |
| inbound avg | 0.10 |
| inbound max | 13.74 |
| scripts avg | 0.02 |
| scripts max | 0.67 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 1.27 |
| streaming max | 5.22 |
| sync avg | 0.27 |
| sync max | 4.03 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 118517.95 |
| ped_p50 | 67.10 |
| ped_p95 | 67.80 |
| ped_p99 | 68.00 |
| samples | 30029776.00 |
| veh_p50 | 67.10 |
| veh_p99 | 67.90 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 5.57 |
| resends | 0.00 |
| syncMsgsPerBotPerSec | 2917.57 |
