# Стресс-тест GoMP: 500 ботов, профиль mixed

- Дата: 2026-10-10T15:42:51+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:500 duration:40s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 5.17 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 26.83 | 33.30 | ✅ |
| script host silence max ms | 1035.12 | 2500.00 | ✅ |
| script hosts lost | 1.00 | 0.00 | ❌ |
| connected bots | 500.00 | 500.00 | ✅ |
| ped sync latency p99 ms | 68.60 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 0.60 |
| deaths | 900.00 |
| gcPauseP99Ms | 0.66 |
| goroutines | 23.00 |
| heapMB | 176.32 |
| hitsPerSec | 102.49 |
| hostCommandsPerSec | 48.16 |
| hostEventsPerSec | 24.31 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 5948.72 |
| hostSilenceMaxMs | 1035.12 |
| hostsDown | 1.00 |
| kbInPerPlayerSec | 1.26 |
| kbOutPerPlayerSec | 35.84 |
| players | 500.00 |
| relBacklogMax | 51.00 |
| rssMB | 228.64 |
| shotsPerSec | 183.27 |
| syncDeferredPerSec | 10.55 |
| syncInPerSec | 13682.93 |
| syncOutPerSec | 437479.29 |
| tickMaxMs | 26.83 |
| tickP50Ms | 1.55 |
| tickP99Ms | 5.17 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 100.00 |
| violations | 2404.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.10 |
| controllers max | 5.16 |
| flush avg | 0.28 |
| flush max | 2.19 |
| hosts avg | 0.06 |
| hosts max | 2.06 |
| inbound avg | 0.38 |
| inbound max | 2.51 |
| scripts avg | 0.08 |
| scripts max | 25.43 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 0.38 |
| streaming max | 2.78 |
| sync avg | 0.40 |
| sync max | 3.20 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 26500.85 |
| ped_p50 | 67.10 |
| ped_p95 | 67.80 |
| ped_p99 | 68.60 |
| samples | 2176607.00 |
| veh_p50 | 67.10 |
| veh_p99 | 100.40 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 16.29 |
| resends | 2.00 |
| syncMsgsPerBotPerSec | 1045.12 |
