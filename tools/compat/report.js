// Writes docs/ragemp-compat.md: how much of the RAGE.MP API GoMP has (server JS,
// client JS, CEF, C#) and what the open-source gamemodes of the test corpus use.
//
//   node tools/compat/report.js [--out docs/ragemp-compat.md]
//
// The corpus (third_party/ragemp/corpus) and RAGE's C# assembly
// (third_party/ragemp/nuget) are local downloads: without them their sections
// say so. The C# numbers need the .NET tool (tools/compat/dotnet, built once).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { load } = require('./api');
const { serverCoverage } = require('./coverage');
const { scan } = require('./scan');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'third_party', 'ragemp', 'corpus');
const BOOTSTRAPPER = path.join(ROOT, 'third_party', 'ragemp', 'nuget', 'bootstrapper', 'lib', 'netcoreapp3.1', 'Bootstrapper.dll');
const COMPAT_EXE = path.join(__dirname, 'dotnet', 'bin', 'out', process.platform === 'win32' ? 'gomp-compat.exe' : 'gomp-compat');

const pct = (have, total) => (total ? `${((100 * have) / total).toFixed(1)}%` : '—');

// Size of a side of the API: paths from mp plus the members of its classes.
function apiSize(side) {
  const api = load(side);
  let n = [...api.globals.keys()].filter((p) => !p.includes('.prototype.')).length;
  for (const members of api.classes.values()) n += members.size;
  return n;
}

function csharp(args) {
  if (!fs.existsSync(COMPAT_EXE) || !fs.existsSync(BOOTSTRAPPER)) return null;
  try {
    return execFileSync(COMPAT_EXE, args, { encoding: 'utf8', env: { ...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT || path.join(process.env.USERPROFILE || '', 'tools', 'dotnet') } });
  } catch (err) {
    return null;
  }
}

function build() {
  const lines = [];
  const out = (s = '') => lines.push(s);
  const server = serverCoverage();
  out('# Совместимость GoMP с API RAGE.MP');
  out();
  out('Сгенерировано `node tools/compat/report.js` по типам `@ragempcommunity/types-*` 2.1.9 и сборке `RAGEMP-Bootstrapper` 1.1.3. Считается наличие имён API (пути от `mp`, члены классов), поведение проверяют тесты.');
  out();
  out('| Часть | Есть | Всего | Покрытие |');
  out('|---|---:|---:|---:|');
  out(`| Сервер, JS (Node) | ${server.have} | ${server.total} | ${pct(server.have, server.total)} |`);
  out(`| Клиент, JS (client_packages) | 0 | ${apiSize('client')} | 0% (клиентского рантайма пока нет) |`);
  out(`| CEF (\`mp.trigger\` в браузере) | 0 | ${apiSize('cef')} | 0% |`);
  const api = csharp(['api', BOOTSTRAPPER]);
  const members = api && /(\d+) members/.exec(api);
  out(`| Сервер, C# (GTANetworkAPI) | 0 | ${members ? members[1] : '?'} | 0% (C#-рантайма пока нет) |`);
  out();
  out('## Сервер, JS: чего нет');
  out();
  const missing = server.sections.filter((s) => s.missing.length);
  if (!missing.length) out('Всё есть.');
  for (const s of missing) out(`- \`${s.name}\`: ${s.missing.map((m) => `\`${m}\``).join(', ')}`);
  out();
  out('## Тестовый корпус (открытые геймоды)');
  out();
  const corpus = [
    ['YARP (AGPL-3.0), сервер', path.join(CORPUS, 'YARP-master', 'packages'), 'server'],
    ['YARP, клиент', path.join(CORPUS, 'YARP-master', 'client_packages'), 'client'],
  ];
  out('| Мод | Файлов | Имён API | Нет в GoMP |');
  out('|---|---:|---:|---:|');
  for (const [name, dir, side] of corpus) {
    if (!fs.existsSync(dir)) {
      out(`| ${name} | — | — | корпус не скачан |`);
      continue;
    }
    const r = scan(dir, side);
    out(`| ${name} | ${r.files} | ${r.used} | ${r.missing} |`);
  }
  const owl = path.join(CORPUS, 'V-main', 'Source');
  const owlScan = fs.existsSync(owl) ? csharp(['scan', owl, '--api', BOOTSTRAPPER]) : null;
  const owlHead = owlScan && /(\d+) files, (\d+) API names/.exec(owlScan);
  out(`| OwlGaming V (GPL-2.0), сервер C# | ${owlHead ? owlHead[1] : '—'} | ${owlHead ? owlHead[2] : '—'} | ${owlHead ? `${owlHead[2]} (нет C#-рантайма)` : 'корпус или инструмент не готовы'} |`);
  out();
  out('Сканер для любого мода:');
  out();
  out('```bash');
  out('node tools/compat/scan.js <папка> --side server|client');
  out('```');
  out();
  out('```bash');
  out('tools/compat/dotnet/bin/out/gomp-compat scan <папка> --api third_party/ragemp/nuget/bootstrapper/lib/netcoreapp3.1/Bootstrapper.dll');
  out('```');
  out();
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'docs', 'ragemp-compat.md');
  fs.writeFileSync(file, build());
  console.log(`written ${file}`);
}

module.exports = { build };
