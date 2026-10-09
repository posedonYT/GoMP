// The HTTP API of the Studio (the browser part calls it, see web/api.js).
//
//   GET    /api/status                      folders and the state of the game files
//   GET    /api/maps                        the maps of the server
//   GET    /api/maps/{name}                 a map (format gomp-map)
//   PUT    /api/maps/{name}                 save (400 with the problems when it has errors)
//   POST   /api/maps/{name}/rename?to=      rename
//   DELETE /api/maps/{name}
//   GET    /api/cursor                      where /mapcursor put an admin (204: nowhere yet)
//   GET    /api/catalog?q=&limit=           models of the game to place (503 while loading)
//   GET    /api/catalog/{model}             one model, by name or hash
//   GET    /api/models/{model}.glb?lod=&tex= the model as glTF (Z up; lod high, med, low, vlow; tex: texture size)
//   GET    /api/world/cell?x=&y=            entities of the world in a cell of 256 m (indices: floor(coord / 256))
//   GET    /api/events                      server-sent events: gta, cursor, maps
using GoMP.Studio.Game;
using GoMP.Studio.Maps;

namespace GoMP.Studio;

public static class Api
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/status", (StudioOptions o, GameData g) => Results.Json(new
        {
            version = typeof(Api).Assembly.GetName().Version?.ToString(),
            gta = new { dir = g.GameDir, state = g.State.ToString().ToLowerInvariant(), status = g.Status },
            maps = o.MapsDir,
            addons = o.AddonsDir,
        }));

        api.MapGet("/maps", (MapStore s) => Results.Json(s.List()));

        api.MapGet("/maps/{name}", (string name, MapStore s) =>
        {
            if (!s.Exists(name)) return Results.NotFound(new { error = "нет такой карты" });
            try
            {
                return Results.Json(s.Load(name), MapDocument.Json);
            }
            catch (System.Text.Json.JsonException e)
            {
                return Results.UnprocessableEntity(new { error = "ошибка в файле карты: " + e.Message });
            }
        });

        api.MapPut("/maps/{name}", async (string name, HttpRequest req, MapStore s, GameData g) =>
        {
            if (!MapStore.ValidName(name)) return Results.BadRequest(new { error = "имя карты: буквы, цифры, _ и -" });
            MapDocument doc;
            try
            {
                doc = await req.ReadFromJsonAsync<MapDocument>(MapDocument.Json);
            }
            catch (System.Text.Json.JsonException e)
            {
                return Results.BadRequest(new { error = "не карта: " + e.Message });
            }
            if (doc == null) return Results.BadRequest(new { error = "пустой запрос" });
            var issues = MapValidator.Check(doc, g.State == GameState.Ready ? g.Has : null);
            if (MapValidator.HasErrors(issues)) return Results.BadRequest(new { error = "в карте есть ошибки", issues });
            s.Save(name, doc);
            return Results.Json(new { saved = true, issues });
        });

        api.MapPost("/maps/{name}/rename", (string name, string to, MapStore s) =>
        {
            if (!s.Exists(name)) return Results.NotFound(new { error = "нет такой карты" });
            if (!MapStore.ValidName(to)) return Results.BadRequest(new { error = "имя карты: буквы, цифры, _ и -" });
            if (s.Exists(to)) return Results.Conflict(new { error = $"карта {to} уже есть" });
            s.Rename(name, to);
            return Results.Json(new { name = to });
        });

        api.MapDelete("/maps/{name}", (string name, MapStore s) =>
        {
            if (!s.Exists(name)) return Results.NotFound(new { error = "нет такой карты" });
            s.Delete(name);
            return Results.NoContent();
        });

        api.MapGet("/cursor", (MapStore s) => s.ReadCursor() is { } c ? Results.Json(c) : Results.NoContent());

        api.MapGet("/catalog", (string q, int? limit, bool? interiors, GameData g) =>
            g.State != GameState.Ready
                ? Results.Json(new { error = g.Status, state = g.State.ToString().ToLowerInvariant() }, statusCode: 503)
                : Results.Json(g.Search(q, limit ?? 60, interiors ?? false)));

        api.MapGet("/catalog/{model}", (string model, GameData g) =>
        {
            if (g.State != GameState.Ready) return Results.Json(new { error = g.Status }, statusCode: 503);
            uint hash = uint.TryParse(model, out uint h) ? h : Joaat.Hash(model);
            return g.Get(hash) is { } a ? Results.Json(a) : Results.NotFound(new { error = $"модели {model} нет в игре" });
        });

        api.MapGet("/models/{file}", (string file, string lod, int? tex, GameData g, GoMP.Studio.Export.ModelCache cache) =>
        {
            if (!file.EndsWith(".glb")) return Results.NotFound();
            if (g.State != GameState.Ready) return Results.Json(new { error = g.Status }, statusCode: 503);
            string model = file[..^4];
            uint hash = uint.TryParse(model, out uint h) ? h : Joaat.Hash(model);
            var level = Enum.TryParse<GoMP.Studio.Export.Lod>(lod ?? "high", true, out var l) ? l : GoMP.Studio.Export.Lod.High;
            int size = Math.Clamp(tex ?? GoMP.Studio.Export.ModelExporter.MaxTextureSize, 16, 2048);
            var data = cache.Get(hash, level, () => g.Exporter.Export(hash, level, size), size);
            return data == null ? Results.NotFound(new { error = $"у модели {model} нет геометрии" }) : Results.File(data, "model/gltf-binary");
        });

        api.MapGet("/world/cell", (int x, int y, GameData g) =>
            g.State != GameState.Ready
                ? Results.Json(new { error = g.Status }, statusCode: 503)
                : Results.Json(g.World.Entities(x, y)));

        VehiclesApi.Map(api);

        api.MapGet("/events", (HttpContext ctx, EventHub hub) => hub.Stream(ctx));
    }
}
