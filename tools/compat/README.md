# tools/compat — совместимость GoMP с API RAGE.MP

API RAGE берётся из определений типов `third_party/ragemp/types-*` (`@ragempcommunity`, MIT) и из сборки C#-сервера RAGE (`RAGEMP-Bootstrapper` из NuGet; она скачивается локально в `third_party/ragemp/nuget` и не хранится в репозитории).

Подготовка — один раз:

```bash
cd tools/compat && npm install
```

```bash
dotnet build tools/compat/dotnet -c Release -o tools/compat/dotnet/bin/out
```

Что есть:

| Команда | Что делает |
|---|---|
| `node tools/compat/report.js` | Пишет `docs/ragemp-compat.md`: покрытие API по частям и сканы тестового корпуса |
| `node tools/compat/scan.js <папка> --side server\|client` | Какие имена API RAGE использует JS-мод и чего из них нет в GoMP |
| `tools/compat/dotnet/bin/out/gomp-compat scan <папка> --api <Bootstrapper.dll> [--impl <фасад GoMP>]` | То же для C#: сборки (точно, по ссылкам в метаданных) и исходники .cs (по тексту) |
| `gomp-compat api <dll>` / `gomp-compat cover <api.dll> <impl.dll>` | Поверхность API сборки; покрытие одной другой |

Тестовый корпус — открытые геймоды (`third_party/ragemp/corpus`, только локально):
- YARP (AGPL-3.0, JS);
- OwlGaming V (GPL-2.0, C#).

Когда придёт код NovaRP, прогоните по нему оба сканера — получится точный список недостающего.
