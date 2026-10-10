# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T15:41:49+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:1000 duration:20s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 10.39 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 17.53 | 33.30 | ✅ |
| script host silence max ms | 3961.24 | 2500.00 | ❌ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 68.60 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.11 |
| deaths | 130.00 |
| gcPauseP99Ms | 0.00 |
| goroutines | 23.00 |
| heapMB | 399.21 |
| hitsPerSec | 43.73 |
| hostCommandsPerSec | 60.10 |
| hostEventsPerSec | 37.96 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 7474.35 |
| hostSilenceMaxMs | 3961.24 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 0.88 |
| kbOutPerPlayerSec | 28.77 |
| players | 1000.00 |
| relBacklogMax | 5.00 |
| rssMB | 413.65 |
| shotsPerSec | 71.89 |
| syncDeferredPerSec | 207.12 |
| syncInPerSec | 19927.15 |
| syncOutPerSec | 798389.86 |
| tickMaxMs | 17.53 |
| tickP50Ms | 2.10 |
| tickP99Ms | 10.39 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 0.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Фазы тика (мс)

| Метрика | Значение |
|---|---:|
| controllers avg | 0.22 |
| controllers max | 9.85 |
| flush avg | 0.53 |
| flush max | 2.00 |
| hosts avg | 0.12 |
| hosts max | 4.66 |
| inbound avg | 0.33 |
| inbound max | 2.67 |
| scripts avg | 0.10 |
| scripts max | 1.08 |
| shapes avg | 0.00 |
| shapes max | 0.52 |
| streaming avg | 0.91 |
| streaming max | 8.54 |
| sync avg | 0.60 |
| sync max | 2.28 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 36646.77 |
| ped_p50 | 67.10 |
| ped_p95 | 67.90 |
| ped_p99 | 68.60 |
| samples | 2006841.00 |
| veh_p50 | 0.00 |
| veh_p99 | 0.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 22.80 |
| resends | 1.00 |
| syncMsgsPerBotPerSec | 867.50 |
