# Стресс-тест GoMP: 1000 ботов, профиль mixed

- Дата: 2026-10-07T15:33:47+03:00
- Машина: map[arch:arm64 cpus:10 go:go1.27.1 os:darwin]
- Параметры: map[bots:1000 duration:40s encryption:true isolate:true jitter:0s latency:0s loss:0 mix:walkers=60,drivers=20,shooters=20 profile:mixed]

## Проверки

| Метрика | Значение | Порог | Итог |
|---|---:|---:|---|
| tick p99 ms | 9.52 | 10.00 | ✅ |
| tick max ms (budget 33.3) | 19.77 | 33.30 | ✅ |
| connected bots | 999.00 | 1000.00 | ❌ |
| ped sync latency p99 ms | 105.50 | 150.00 | ✅ |

## Сервер

| Метрика | Значение |
|---|---:|
| cpuCores | 1.61 |
| deaths | 2943.00 |
| gcPauseP99Ms | 0.10 |
| goroutines | 17.00 |
| heapMB | 322.27 |
| hitsPerSec | 335.22 |
| hostCommandsPerSec | 149.85 |
| hostEventsPerSec | 76.89 |
| kbInPerPlayerSec | 1.24 |
| kbOutPerPlayerSec | 60.33 |
| players | 999.00 |
| rssMB | 508.83 |
| shotsPerSec | 584.05 |
| syncDeferredPerSec | 334.72 |
| syncInPerSec | 25742.01 |
| syncOutPerSec | 1391889.10 |
| tickMaxMs | 19.77 |
| tickP50Ms | 4.58 |
| tickP99Ms | 9.52 |
| vehicles | 201.00 |
| violations | 3046.00 |

## Задержка синхронизации бот→бот (мс)

| Метрика | Значение |
|---|---:|
| ped_max | 28010.48 |
| ped_p50 | 66.50 |
| ped_p95 | 75.70 |
| ped_p99 | 105.50 |
| samples | 6921162.00 |
| veh_p50 | 65.70 |
| veh_p99 | 102.40 |

## Боты

| Метрика | Значение |
|---|---:|
| avgLoss | 0.00 |
| avgRttMs | 36.81 |
| resends | 306.00 |
| syncMsgsPerBotPerSec | 1745.63 |

## Ошибки

- Подключение: map[transport: handshake: context deadline exceeded:1]
- Отключения: map[]
