// The vehicle editor's part of the API (packs of client-dist/addons):
//
//   GET  /api/vehicles                                packs and their vehicles
//   GET  /api/vehicles/schema                         editable fields (labels, units, ranges)
//   GET  /api/vehicles/palette                        the game's paint colours (503 without the game)
//   GET  /api/vehicles/game                           the game's own vehicles: model, make, class, speed (dealership catalog)
//   GET  /api/vehicles/{pack}/{model}                 the vehicle (data, handling, colours, kits, lights, problems)
//   PUT  /api/vehicles/{pack}/{model}                 changes (VehiclePatch), written into the pack
//   POST /api/vehicles/{pack}/{model}/handling        copy the game's handling into the pack
//   GET  /api/vehicles/{pack}/{model}/model.glb?tex=  the vehicle in 3D
//   GET  /api/vehicles/{pack}/{model}/part/{name}.glb a mod part (spoiler, bumper...) to try on
//   GET  /api/vehicles/{pack}/files                   text files of the pack
//   GET  /api/vehicles/{pack}/file?path=              one of them; PUT writes it (must be valid XML)
using System.Collections.Concurrent;
using GoMP.Studio.Game;
using GoMP.Studio.Vehicles;

namespace GoMP.Studio;

public static class VehiclesApi
{
    private static readonly ConcurrentDictionary<string, byte[]> Models = new();

    private static AddonPack Pack(StudioOptions o, string name) =>
        AddonPack.List(o.AddonsDir).FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));

    private static IResult Problem(Exception e) => e switch
    {
        KeyNotFoundException => Results.NotFound(new { error = e.Message }),
        ArgumentException or InvalidOperationException or InvalidDataException or System.Xml.XmlException or FormatException =>
            Results.BadRequest(new { error = e.Message }),
        _ => Results.Json(new { error = e.Message }, statusCode: 500),
    };

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/vehicles", (StudioOptions o) => Results.Json(AddonPack.List(o.AddonsDir).Select(p => new
        {
            pack = p.Name,
            models = VehicleEditor.Models(p).Select(m => new { model = m.Model, gameName = m.GameName, make = m.Make, cls = m.Class }),
        })));

        // NaN (no limit) is not JSON: such limits go out as null; kinds as their names.
        static object Field(FieldDef f) => new
        {
            f.Name, f.Label, Kind = f.Kind.ToString(), f.Unit, Min = double.IsNaN(f.Min) ? (double?)null : f.Min,
            Max = double.IsNaN(f.Max) ? (double?)null : f.Max, f.Help, f.Choices, f.Group,
        };
        api.MapGet("/vehicles/schema", () => Results.Json(new { data = VehicleSchema.Data.Select(Field), handling = VehicleSchema.Handling.Select(Field) }));

        api.MapGet("/vehicles/palette", (GameData g) =>
            g.State != GameState.Ready ? Results.Json(new { error = g.Status }, statusCode: 503) : Results.Json(g.Vehicles.Palette));

        api.MapGet("/vehicles/game", (GameData g) =>
            g.State != GameState.Ready ? Results.Json(new { error = g.Status }, statusCode: 503) : Results.Json(g.Vehicles.All));

        api.MapGet("/vehicles/{pack}/{model}", (string pack, string model, StudioOptions o, GameData g) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            try
            {
                return Results.Json(VehicleEditor.Read(p, model, g.State == GameState.Ready ? g.Vehicles : null, AddonPack.List(o.AddonsDir)));
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });

        api.MapPut("/vehicles/{pack}/{model}", async (string pack, string model, HttpRequest req, StudioOptions o, GameData g) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            try
            {
                var patch = await req.ReadFromJsonAsync<VehiclePatch>();
                VehicleEditor.Apply(p, model, patch ?? new VehiclePatch());
                Forget(p);
                return Results.Json(VehicleEditor.Read(p, model, g.State == GameState.Ready ? g.Vehicles : null, AddonPack.List(o.AddonsDir)));
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });

        api.MapPost("/vehicles/{pack}/{model}/handling", (string pack, string model, StudioOptions o, GameData g) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            if (g.State != GameState.Ready) return Results.Json(new { error = "нужны файлы игры: " + g.Status }, statusCode: 503);
            try
            {
                VehicleEditor.OwnHandling(p, model, g.Vehicles);
                return Results.Json(VehicleEditor.Read(p, model, g.Vehicles, AddonPack.List(o.AddonsDir)));
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });

        api.MapGet("/vehicles/{pack}/{model}/model.glb", (string pack, string model, int? tex, StudioOptions o, GameData g) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            int size = Math.Clamp(tex ?? 1024, 64, 2048);
            string key = $"{p.File}|{File.GetLastWriteTimeUtc(p.File).Ticks}|{model.ToLowerInvariant()}|{size}";
            try
            {
                var data = Models.GetOrAdd(key, _ => g.State == GameState.Ready
                    ? g.Exporter.ExportVehicle(p, model, size)
                    : GoMP.Studio.Export.ModelExporter.ExportVehicle(p, model, null, null, size));
                if (data == null)
                {
                    Models.TryRemove(key, out _);
                    return Results.NotFound(new { error = $"в паке нет модели {model}.yft" });
                }
                return Results.File(data, "model/gltf-binary");
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });

        // A mod part of the pack (vehiclemods), with the textures of its vehicle.
        api.MapGet("/vehicles/{pack}/{model}/part/{part}", (string pack, string model, string part, StudioOptions o, GameData g) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            string name = part.EndsWith(".glb") ? part[..^4] : part;
            string key = $"{p.File}|{File.GetLastWriteTimeUtc(p.File).Ticks}|part|{model.ToLowerInvariant()}|{name.ToLowerInvariant()}";
            try
            {
                var data = Models.GetOrAdd(key, _ => g.State == GameState.Ready
                    ? g.Exporter.ExportVehicle(p, name, 512, model)
                    : GoMP.Studio.Export.ModelExporter.ExportVehicle(p, name, null, null, 512, model));
                if (data == null)
                {
                    Models.TryRemove(key, out _);
                    return Results.NotFound(new { error = $"{name}: в паке нет такой детали (деталь из игры?) — примерить можно только детали пака" });
                }
                return Results.File(data, "model/gltf-binary");
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });

        api.MapGet("/vehicles/{pack}/files", (string pack, StudioOptions o) =>
            Pack(o, pack) is { } p ? Results.Json(p.TextFiles()) : Results.NotFound(new { error = $"нет пака {pack}" }));

        api.MapGet("/vehicles/{pack}/file", (string pack, string path, StudioOptions o) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            try
            {
                return Results.Text(p.ReadText(path), "text/xml; charset=utf-8");
            }
            catch (Exception e)
            {
                return Problem(e is FileNotFoundException ? new KeyNotFoundException(e.Message) : e);
            }
        });

        api.MapPut("/vehicles/{pack}/file", async (string pack, string path, HttpRequest req, StudioOptions o) =>
        {
            var p = Pack(o, pack);
            if (p == null) return Results.NotFound(new { error = $"нет пака {pack}" });
            string text = await new StreamReader(req.Body).ReadToEndAsync();
            try
            {
                System.Xml.Linq.XDocument.Parse(text);  // a broken file would break the game's loading
                if (!p.TextFiles().Contains(path, StringComparer.OrdinalIgnoreCase)) throw new KeyNotFoundException($"в паке нет файла {path}");
                p.WriteText(path, text);
                Forget(p);
                return Results.Json(new { saved = true });
            }
            catch (Exception e)
            {
                return Problem(e);
            }
        });
    }

    private static void Forget(AddonPack p)
    {
        foreach (var k in Models.Keys.Where(k => k.StartsWith(p.File + "|"))) Models.TryRemove(k, out _);
    }
}
