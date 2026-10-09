// GoMP Studio: the local web server of the map and vehicle editor. It serves the
// browser part (tools/studio/web) and an API over the game files (CodeWalker.Core),
// the server's maps (server-files/maps) and the add-on packs (client-dist/addons).
//
//   gomp-studio --gta "E:\GTAV"                 then http://127.0.0.1:22100
//   gomp-studio --gta ~/GTAV --server-files ./server-files --addons ./client-dist/addons --port 22100 --no-browser
using System.Diagnostics;
using GoMP.Studio;
using Microsoft.Extensions.FileProviders;
using GoMP.Studio.Game;
using GoMP.Studio.Maps;

Console.OutputEncoding = System.Text.Encoding.UTF8;
// --web <folder>: the pages straight from tools/studio/web (while working on them);
// else the copy built into the program.
int webArg = Array.IndexOf(args, "--web");
string webDir = webArg >= 0 && webArg + 1 < args.Length ? Path.GetFullPath(args[webArg + 1]) : null;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.Configuration.AddCommandLine(args.Select(a => a == "--no-browser" ? "--no-browser=1" : a).ToArray(), StudioOptions.Switches);
// Only the port is needed before the app is built; the folders are read from the final
// configuration (tests set them through WebApplicationFactory).
builder.WebHost.UseUrls($"http://127.0.0.1:{StudioOptions.From(builder.Configuration).Port}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);

builder.Services.AddSingleton(sp => StudioOptions.From(sp.GetRequiredService<IConfiguration>()));
builder.Services.AddSingleton<EventHub>();
builder.Services.AddSingleton(sp => new GameData(sp.GetRequiredService<StudioOptions>().GtaDir));
builder.Services.AddSingleton(sp => new MapStore(sp.GetRequiredService<StudioOptions>().MapsDir));
builder.Services.AddSingleton<MapWatcher>();
builder.Services.AddSingleton(sp => new GoMP.Studio.Export.ModelCache(sp.GetRequiredService<StudioOptions>().CacheDir));

var app = builder.Build();
IFileProvider web = webDir != null ? new PhysicalFileProvider(webDir) : new EmbeddedWeb(typeof(Program).Assembly);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = web });
// Revalidated on every load: after an update the browser must not run old modules.
app.UseStaticFiles(new StaticFileOptions { FileProvider = web, OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "no-cache" });
Api.Map(app);

var options = app.Services.GetRequiredService<StudioOptions>();
var hub = app.Services.GetRequiredService<EventHub>();
var game = app.Services.GetRequiredService<GameData>();
game.Changed += (state, status) =>
{
    hub.Publish("gta", new { state = state.ToString().ToLowerInvariant(), status });
    if (state == GameState.Failed) Console.Error.WriteLine(game.Error?.ToString() ?? status);
};
app.Services.GetRequiredService<MapWatcher>();

app.Lifetime.ApplicationStarted.Register(() =>
{
    string url = $"http://127.0.0.1:{options.Port}";
    Console.WriteLine($"GoMP Studio: {url}");
    Console.WriteLine($"  карты: {options.MapsDir}");
    Console.WriteLine($"  паки машин: {options.AddonsDir}");
    Console.WriteLine($"  игра: {options.GtaDir ?? "не указана (--gta <папка GTA V>)"}");
    _ = game.StartLoading();
    if (options.OpenBrowser) OpenBrowser(url);
});

app.Run();

static void OpenBrowser(string url)
{
    try
    {
        if (OperatingSystem.IsWindows()) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        else if (OperatingSystem.IsMacOS()) Process.Start("open", url);
        else Process.Start("xdg-open", url);
    }
    catch (Exception e)
    {
        Console.WriteLine("откройте в браузере: " + url + " (" + e.Message + ")");
    }
}

// For WebApplicationFactory in the tests.
public partial class Program
{
}
