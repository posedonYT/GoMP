# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-10T15:38:08+03:00
- Машина: map[arch:amd64 cpus:12 go:go1.27.1 os:windows]
- Параметры: map[auth:false bots:1000 duration:45s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 13.38 | 10.00 | ❌ |
| tick max ms (budget 33.3) | 19.04 | 33.30 | ✅ |
| script host silence max ms | 1038.56 | 2500.00 | ✅ |
| script hosts lost | 0.00 | 0.00 | ✅ |
| connected bots | 1000.00 | 1000.00 | ✅ |
| ped sync latency p99 ms | 100.20 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.96 |
| deaths | 3521.00 |
| gcPauseP99Ms | 0.92 |
| goroutines | 23.00 |
| heapMB | 393.84 |
| hitsPerSec | 354.77 |
| hostCommandsPerSec | 155.88 |
| hostEventsPerSec | 78.07 |
| hostOpsDeferred | 0.00 |
| hostOpsOutPerSec | 12981.62 |
| hostSilenceMaxMs | 1038.56 |
| hostsDown | 0.00 |
| kbInPerPlayerSec | 1.31 |
| kbOutPerPlayerSec | 63.04 |
| players | 1000.00 |
| relBacklogMax | 13.00 |
| rssMB | 502.65 |
| shotsPerSec | 615.75 |
| syncDeferredPerSec | 0.04 |
| syncInPerSec | 27584.05 |
| syncOutPerSec | 1459212.58 |
| tickMaxMs | 19.04 |
| tickP50Ms | 5.87 |
| tickP99Ms | 13.38 |
| ticksMissed | 0.00 |
| ticksOver | 0.00 |
| vehicles | 200.00 |
| violations | 0.00 |
| writerStalls | 0.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 1139.71 |
| ped_p50 | 67.00 |
| ped_p95 | 69.60 |
| ped_p99 | 100.20 |
| samples | 8174637.00 |
| veh_p50 | 66.50 |
| veh_p99 | 73.00 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 19.99 |
| resends | 24.00 |
| syncMsgsPerBotPerSec | 1714.87 |
