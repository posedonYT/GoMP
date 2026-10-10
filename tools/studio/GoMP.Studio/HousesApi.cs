// The houses editor's part of the API (server-files/houses.json):
//
//   GET /api/houses                      { doc, states, nextId, issues }
//   PUT /api/houses                      the whole document; 400 { error, issues } when it has errors (the file stays)
//   GET /api/interiors/geometry?x=&y=&z=&r=&only=  entities of the MLO interiors within r m (default 60) of the point, in world space,
//                                        in the format of /api/world/cell plus m (index into mlos). mlos: {name, hash, pos, entities, contains}, the ones
//                                        containing the point first, then by distance; only=contains: just those (else the nearest). 503 while the game loads
//                                        mlos[].entrance: index into doors of the likely front door (-1: none). doors: {m, kind, model, outside, room, roomFrom, roomTo,
//                                        center, normal (unit, horizontal, into the room), bottom (floor z), width, height, corners}; kind: portal / door / hall / hallway
//   GET /api/roads/nearest?x=&y=&z=&r=  vehicle path nodes within r m (5..200, default 60) of the point: { nodes: [{ pos, headings, dist }] (nearest first, up to 5),
//                                        suggest: { pos, heading } | null }. suggest: the nearest node, z + 1, the link heading that keeps (x, y) on the right. 503 while the game loads
using GoMP.Studio.Game;
using GoMP.Studio.Houses;

namespace GoMP.Studio;

public static class HousesApi
{
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/houses", (HousesStore s, GameData g) =>
        {
            HousesDocument doc;
            try
            {
                doc = s.Load();
            }
            catch (System.Text.Json.JsonException e)
            {
                return Results.UnprocessableEntity(new { error = "ошибка в файле домов: " + e.Message });
            }
            var states = s.ReadStates();
            return Results.Json(new
            {
                doc = System.Text.Json.JsonSerializer.SerializeToElement(doc, HousesDocument.Json),
                states = states.ToDictionary(p => p.Key.ToString(), p => new
                {
                    owner = p.Value.Owner,
                    ownerName = p.Value.OwnerName,
                    locked = p.Value.Locked,
                    garage = p.Value.GarageCount,
                }),
                nextId = HousesStore.NextId(doc, states),
                issues = HousesValidator.Check(doc, g.State == GameState.Ready ? g.Has : null),
            });
        });

        api.MapPut("/houses", async (HttpRequest req, HousesStore s, GameData g) =>
        {
            HousesDocument doc;
            try
            {
                doc = await req.ReadFromJsonAsync<HousesDocument>(HousesDocument.Json);
            }
            catch (System.Text.Json.JsonException e)
            {
                return Results.BadRequest(new { error = "не документ домов: " + e.Message });
            }
            if (doc == null) return Results.BadRequest(new { error = "пустой запрос" });
            var issues = HousesValidator.Check(doc, g.State == GameState.Ready ? g.Has : null);
            if (HousesValidator.HasErrors(issues)) return Results.Json(new { error = "в документе есть ошибки", issues }, statusCode: 400);
            s.Save(doc);
            return Results.Json(new { saved = true, issues, nextId = HousesStore.NextId(doc, s.ReadStates()) });
        });

        api.MapGet("/interiors/geometry", (float x, float y, float z, float? r, string only, GameData g) =>
        {
            if (g.State != GameState.Ready)
                return Results.Json(new { error = g.Status, state = g.State.ToString().ToLowerInvariant() }, statusCode: 503);
            var geo = g.World.InteriorsNear(x, y, z, Math.Clamp(r ?? 60, 1, 300), onlyContains: only == "contains");
            return Results.Json(new { mlos = geo.Mlos, entities = geo.Entities, doors = geo.Doors });
        });

        // Vehicle path nodes near a point (a house door): where a garage entrance can go, and how it would face.
        api.MapGet("/roads/nearest", (float x, float y, float z, float? r, GameData g) =>
        {
            if (g.State != GameState.Ready)
                return Results.Json(new { error = g.Status, state = g.State.ToString().ToLowerInvariant() }, statusCode: 503);
            var hits = g.Roads.Nearest(x, y, z, Math.Clamp(r ?? 60, 5, 200));
            var suggest = hits.Count == 0 ? null : RoadNodes.Suggest(hits[0].Node, x, y);
            return Results.Json(new
            {
                nodes = hits.Select(h => new { pos = new[] { h.Node.X, h.Node.Y, h.Node.Z }, headings = h.Node.Headings, dist = h.Dist }),
                suggest = suggest == null ? null : new { pos = new[] { suggest.X, suggest.Y, suggest.Z }, heading = suggest.Heading },
            });
        });
    }
}
