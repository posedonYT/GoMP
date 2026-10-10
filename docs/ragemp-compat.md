# Совместимость GoMP с API RAGE.MP

Сгенерировано `node tools/compat/report.js` по типам `@ragempcommunity/types-*` 2.1.9 и сборке `RAGEMP-Bootstrapper` 1.1.3. Считается наличие имён API (пути от `mp`, члены классов), поведение проверяют тесты.

| Часть | Есть | Всего | Покрытие |
|---|---:|---:|---:|
| Сервер, JS (Node) | 261 | 261 | 100.0% |
| Клиент, JS (client_packages) | 0 | 9152 | 0% (клиентского рантайма пока нет) |
| CEF (`mp.trigger` в браузере) | 0 | 7 | 0% |
| Сервер, C# (GTANetworkAPI) | 0 | 7447 | 0% (C#-рантайма пока нет) |

## Сервер, JS: чего нет

Всё есть.

## Тестовый корпус (открытые геймоды)

| Мод | Файлов | Имён API | Нет в GoMP |
|---|---:|---:|---:|
| YARP (AGPL-3.0), сервер | 80 | 80 | 0 |
| YARP, клиент | 46 | 91 | 91 |
| OwlGaming V (GPL-2.0), сервер C# | 632 | 139 | 139 (нет C#-рантайма) |

Сканер для любого мода:

```bash
node tools/compat/scan.js <папка> --side server|client
```

```bash
tools/compat/dotnet/bin/out/gomp-compat scan <папка> --api third_party/ragemp/nuget/bootstrapper/lib/netcoreapp3.1/Bootstrapper.dll
```

