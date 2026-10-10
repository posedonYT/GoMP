using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using GoMP.Gta;
using GoMP.Studio.Vehicles;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit.Abstractions;

namespace GoMP.Studio.Tests;

// The vehicle API on a copy of the test pack (no game files).
public sealed class VehicleApiTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "gomp-vapi-" + Guid.NewGuid().ToString("N"));
    private readonly WebApplicationFactory<Program> factory;
    private readonly HttpClient http;

    public VehicleApiTests()
    {
        Archives.Pack(Path.Combine(AppContext.BaseDirectory, "testdata", "pack"), Path.Combine(root, "addons", "testcar", "dlc.rpf"));
        Directory.CreateDirectory(Path.Combine(root, "server-files"));
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Studio:ServerFiles", Path.Combine(root, "server-files"));
            b.UseSetting("Studio:Addons", Path.Combine(root, "addons"));
            b.UseSetting("Studio:Gta", "");
            b.UseSetting("Studio:NoBrowser", "1");
        });
        http = factory.CreateClient();
    }

    public void Dispose()
    {
        http.Dispose();
        factory.Dispose();
        Directory.Delete(root, true);
    }

    [Fact]
    public async Task Lists_reads_and_changes_a_vehicle()
    {
        var schema = await http.GetFromJsonAsync<JsonElement>("/api/vehicles/schema");
        Assert.Equal("Choice", schema.GetProperty("data").EnumerateArray().First(f => f.GetProperty("name").GetString() == "vehicleClass").GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, schema.GetProperty("data")[0].GetProperty("min").ValueKind);
        Assert.Equal(50, schema.GetProperty("handling")[0].GetProperty("min").GetDouble());

        var packs = await http.GetFromJsonAsync<JsonElement>("/api/vehicles");
        Assert.Equal("testcar", packs[0].GetProperty("pack").GetString());
        Assert.Equal(2, packs[0].GetProperty("models").GetArrayLength());

        var v = await http.GetFromJsonAsync<JsonElement>("/api/vehicles/testcar/testcar");
        Assert.Equal("TESTCAR", v.GetProperty("data").GetProperty("gameName").GetString());
        Assert.Equal(1500, v.GetProperty("handling").GetProperty("fields").GetProperty("fMass").GetDouble());

        var put = await http.PutAsJsonAsync("/api/vehicles/testcar/testcar", new { data = new { gameName = "NEW" }, handling = new { fMass = 1234.5 } });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var after = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("NEW", after.GetProperty("data").GetProperty("gameName").GetString());
        Assert.Equal(1234.5, after.GetProperty("handling").GetProperty("fields").GetProperty("fMass").GetDouble(), 3);

        var bad = await http.PutAsJsonAsync("/api/vehicles/testcar/testcar", new { data = new { txdName = "x" } });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/api/vehicles/testcar/nope")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/api/vehicles/nopack/testcar")).StatusCode);
        // Copying the game's handling needs the game.
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await http.PostAsync("/api/vehicles/testcar/othercar/handling", null)).StatusCode);
        // A mod part the pack does not have (the test pack has no models at all).
        var part = await http.GetAsync("/api/vehicles/testcar/testcar/part/testcar_wing.glb");
        Assert.Equal(HttpStatusCode.NotFound, part.StatusCode);
        Assert.Contains("testcar_wing", (await part.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Raw_files_are_edited_but_must_stay_xml()
    {
        var files = await http.GetFromJsonAsync<string[]>("/api/vehicles/testcar/files");
        Assert.Contains(@"common\data\carcols.meta", files);
        string path = Uri.EscapeDataString(@"common\data\carcols.meta");
        string text = await http.GetStringAsync($"/api/vehicles/testcar/file?path={path}");
        Assert.Contains("<id value=\"950\" />", text);
        var ok = await http.PutAsync($"/api/vehicles/testcar/file?path={path}", new StringContent(text.Replace("950", "2020")));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Contains("2020", await http.GetStringAsync($"/api/vehicles/testcar/file?path={path}"));
        var broken = await http.PutAsync($"/api/vehicles/testcar/file?path={path}", new StringContent("<Kits><Item>"));
        Assert.Equal(HttpStatusCode.BadRequest, broken.StatusCode);
        Assert.Contains("2020", await http.GetStringAsync($"/api/vehicles/testcar/file?path={path}"));
        var unknown = await http.PutAsync($"/api/vehicles/testcar/file?path=x.meta", new StringContent("<a/>"));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }
}

// The game's vehicle data and the real packs of client-dist/addons (read only).
[Collection("game")]
public sealed class VehicleGameTests
{
    private readonly GameFixture fixture;
    private readonly ITestOutputHelper output;

    public VehicleGameTests(GameFixture fixture, ITestOutputHelper output)
    {
        this.fixture = fixture;
        this.output = output;
    }

    private static string AddonsDir
    {
        get
        {
            for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
                if (Directory.Exists(Path.Combine(d.FullName, "client-dist", "addons"))) return Path.Combine(d.FullName, "client-dist", "addons");
            return null;
        }
    }

    [GameFact]
    public void Knows_the_games_handling_kits_lights_and_paints()
    {
        var sw = Stopwatch.StartNew();
        var g = fixture.Game.Vehicles;
        output.WriteLine($"game vehicle data in {sw.ElapsedMilliseconds} ms: {g.Handling.Count} handling, {g.KitIds.Count} kits, {g.LightIds.Count} lights, {g.Palette.Count} paints");
        Assert.True(g.Handling.ContainsKey("FELON2"));
        Assert.True(g.Handling.ContainsKey("ADDER"));
        Assert.True(g.KitIds.Count > 100);
        Assert.True(g.Palette.Count > 100);
        Assert.Contains(g.Palette, c => c.Index == 0 && c.Rgb.StartsWith('#'));
        Assert.Contains("felon2", g.Models);
    }

    // The dealership catalog (tools/dealership/generate.js) is made from this list.
    [GameFact]
    public void Lists_the_games_vehicles_with_class_make_and_top_speed()
    {
        var all = fixture.Game.Vehicles.All;
        Assert.True(all.Count > 500, $"{all.Count} vehicles");
        var adder = all.Single(v => v.Model == "adder");
        Assert.Equal(7, adder.Class);  // VC_SUPER
        Assert.Equal("TRUFFADE", adder.Make);
        Assert.Equal("VEHICLE_TYPE_CAR", adder.Type);
        Assert.InRange(adder.Speed, 140, 180);
        Assert.Equal(18, all.Single(v => v.Model == "police").Class);  // VC_EMERGENCY
        Assert.Contains("FLAG_HAS_TURRET_SEAT_ON_VEHICLE", all.Single(v => v.Model == "insurgent").Flags);
        Assert.Equal(all.Count, all.Select(v => v.Model).Distinct().Count());
    }

    [Fact]
    public void Vehicle_classes_map_to_the_games_numbers()
    {
        Assert.Equal(0, GameVehicles.ClassOf("VC_COMPACT"));
        Assert.Equal(7, GameVehicles.ClassOf("vc_super"));
        Assert.Equal(22, GameVehicles.ClassOf("VC_OPEN_WHEEL"));
        Assert.Equal(-1, GameVehicles.ClassOf("VC_SPACESHIP"));
        Assert.Equal(-1, GameVehicles.ClassOf(null));
    }

    [GameFact]
    public void Reads_the_real_packs_and_finds_their_problems()
    {
        Assert.NotNull(AddonsDir);
        var packs = AddonPack.List(AddonsDir);
        foreach (var p in packs)
            foreach (var m in VehicleEditor.Models(p))
            {
                var v = VehicleEditor.Read(p, m.Model, fixture.Game.Vehicles, packs);
                output.WriteLine($"{p.Name}/{m.Model}: handling {v.Handling.Name} ({v.Handling.Source}), kits {string.Join(",", v.Kits.Select(k => k.Id))}, " +
                                 $"lights {string.Join(",", v.Lights.Select(l => l.Id))}; {string.Join("; ", v.Issues.Select(i => i.Severity + ": " + i.Message))}");
                Assert.NotEqual("missing", v.Handling.Source);
            }
        var g37 = VehicleEditor.Read(packs.Single(p => p.Name == "g37s"), "g37s", fixture.Game.Vehicles, packs);
        Assert.Equal(("FELON2", "game"), (g37.Handling.Name, g37.Handling.Source));
    }

    [GameFact]
    public void A_pack_vehicle_in_3d_has_its_wheels_and_paint()
    {
        var pack = AddonPack.List(AddonsDir).Single(p => p.Name == "g37s");
        var data = fixture.Game.Exporter.ExportVehicle(pack, "g37s", 256);
        Assert.NotNull(data);
        var glb = Glb.Parse(data);
        var names = glb.Json.GetProperty("nodes").EnumerateArray().Select(n => n.TryGetProperty("name", out var x) ? x.GetString() : "").ToList();
        foreach (string part in new[] { "wheel_lf", "wheel_rf", "wheel_lr", "wheel_rr", "door_dside_f", "bonnet", "boot" })
            Assert.Contains(part, names);
        // Wheels have geometry under them.
        var nodes = glb.Json.GetProperty("nodes");
        var wheel = nodes.EnumerateArray().First(n => n.TryGetProperty("name", out var x) && x.GetString() == "wheel_rf" && n.TryGetProperty("extras", out var e) && e.TryGetProperty("part", out _));
        Assert.True(wheel.GetProperty("children").GetArrayLength() > 0);
        // Doors are cut out of the skinned body onto their bones: they can be opened.
        var door = nodes.EnumerateArray().First(n => n.TryGetProperty("name", out var x) && x.GetString() == "door_dside_f");
        Assert.True(door.TryGetProperty("children", out var kids) && kids.EnumerateArray().Any(k => nodes[k.GetInt32()].TryGetProperty("mesh", out _)),
            "door_dside_f has geometry");
        Assert.Contains(glb.Json.GetProperty("materials").EnumerateArray(), m => m.TryGetProperty("extras", out var e) && e.TryGetProperty("paint", out _));
        Assert.True(glb.Json.GetProperty("images").GetArrayLength() > 3);
    }

    [GameFact]
    public void A_mod_part_in_3d_takes_the_textures_of_its_vehicle()
    {
        var pack = AddonPack.List(AddonsDir).Single(p => p.Name == "m5");
        var kit = VehicleEditor.Read(pack, "m5", fixture.Game.Vehicles, null).Kits.Single();
        var hood = kit.Mods.Single(m => m.ModelName == "m5_hood");
        Assert.Equal("VMT_BONNET", hood.Type);
        Assert.Contains("bonnet", hood.TurnOff);
        // m5_hood's own textures are stubs: without m5.ytd it is grey.
        var data = fixture.Game.Exporter.ExportVehicle(pack, "m5_hood", 256, "m5");
        Assert.NotNull(data);
        var glb = Glb.Parse(data);
        Assert.True(glb.Json.GetProperty("images").GetArrayLength() >= 3);
        Assert.Contains(glb.Json.GetProperty("materials").EnumerateArray(), m => m.TryGetProperty("extras", out var e) && e.TryGetProperty("paint", out _));
        Assert.Null(fixture.Game.Exporter.ExportVehicle(pack, "bobble_mar1_head", 256, "m5"));
    }
}
