using System.Text.Json;
using GoMP.Gta;
using GoMP.Studio.Vehicles;

namespace GoMP.Studio.Tests;

// The vehicle editor on a small pack made for the tests (testdata/pack), packed
// into a temporary dlc.rpf like a real add-on pack.
public sealed class VehicleTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "gomp-pack-" + Guid.NewGuid().ToString("N"));
    private readonly AddonPack pack;
    private readonly GameVehicles game = new();

    public VehicleTests()
    {
        string src = Path.Combine(AppContext.BaseDirectory, "testdata", "pack");
        Archives.Pack(src, Path.Combine(dir, "testcar", "dlc.rpf"));
        pack = AddonPack.List(dir).Single();
        // What "the game" has: FELON2's handling, a kit and a light id, two paints.
        game.AddHandling("""<CHandlingDataMgr><HandlingData><Item type="CHandlingData"><handlingName>FELON2</handlingName><fMass value="1700.0" /><fInitialDriveForce value="0.29" /><vecCentreOfMassOffset x="0" y="0" z="0" /></Item></HandlingData></CHandlingDataMgr>""");
        game.KitIds.Add(950);
        game.LightIds.Add(223);  // 2783 & 0xFF
        game.Models.Add("FELON2");
        game.Palette.Add(new PaintColor(0, "Black", "#000000"));
        game.Palette.Add(new PaintColor(1, "White", "#ffffff"));
    }

    public void Dispose() => Directory.Delete(dir, true);

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void Lists_the_vehicles_of_a_pack()
    {
        Assert.Equal("testcar", pack.Name);
        var models = VehicleEditor.Models(pack).ToList();
        Assert.Equal(new[] { "testcar", "othercar" }, models.Select(m => m.Model));
        Assert.Equal(("TESTCAR", "GOMP", "VC_COUPE"), (models[0].GameName, models[0].Make, models[0].Class));
        Assert.Contains(@"common\data\carcols.meta", pack.TextFiles());
    }

    [Fact]
    public void Reads_data_handling_colours_kits_and_lights()
    {
        var v = VehicleEditor.Read(pack, "TestCar", game);
        Assert.Equal("testcar", v.Model);
        Assert.Equal("TESTCAR", v.Data["gameName"]);
        Assert.Equal(new[] { "FLAG_SPORTS", "FLAG_RICH_CAR" }, (string[])v.Data["flags"]);
        Assert.Equal("pack", v.Handling.Source);
        Assert.Equal(1500f, v.Handling.Fields["fMass"]);
        Assert.Equal(6, v.Handling.Fields["nInitialDriveGears"]);
        Assert.Equal(new[] { 0f, 0.05f, -0.1f }, (float[])v.Handling.Fields["vecCentreOfMassOffset"]);
        Assert.Equal(new[] { 111, 111, 0, 156 }, v.Variation.Colors.Single());
        Assert.Equal(2783, v.Variation.LightSettings);
        var kit = Assert.Single(v.Kits);
        Assert.Equal(("2020_testcar_modkit", 950), (kit.Name, kit.Id));
        Assert.Equal(new[] { "misc_a" }, kit.Mods.Single().TurnOff);
        Assert.Equal(2783, Assert.Single(v.Lights).Id);

        var other = VehicleEditor.Read(pack, "othercar", game);
        Assert.Equal("game", other.Handling.Source);
        Assert.Equal(1700f, other.Handling.Fields["fMass"]);
        Assert.Throws<KeyNotFoundException>(() => VehicleEditor.Read(pack, "nope", game));
    }

    [Fact]
    public void Finds_what_breaks_in_the_game()
    {
        var issues = VehicleEditor.Read(pack, "testcar", game).Issues;
        Assert.Contains(issues, i => i.Severity == "error" && i.Field == "kit.2020_testcar_modkit" && i.Message.Contains("950"));
        Assert.Contains(issues, i => i.Severity == "warning" && i.Message.Contains("2783") && i.Message.Contains("223"));
        Assert.Contains(issues, i => i.Severity == "error" && i.Field == "light.2783");

        var v = VehicleEditor.Read(pack, "testcar", game);
        v.Data["gameName"] = "A VERY LONG NAME";
        v.Data["audioNameHash"] = "NOSUCHCAR";
        v.Handling.Fields["fMass"] = 10f;
        v.Variation.Colors.Add(new[] { 0, 300, 0, 0 });
        var more = VehicleEditor.Check(v, game);
        Assert.Contains(more, i => i.Field == "gameName");
        Assert.Contains(more, i => i.Field == "audioNameHash");
        Assert.Contains(more, i => i.Field == "handling.fMass");
        Assert.Contains(more, i => i.Field == "variation.colors");
    }

    [Fact]
    public void Changes_go_into_the_files_and_the_rest_stays()
    {
        VehicleEditor.Apply(pack, "testcar", new VehiclePatch
        {
            Data = new() { ["gameName"] = J("\"G37S\""), ["flags"] = J("[\"FLAG_SPORTS\"]"), ["vehicleClass"] = J("\"VC_SPORT\"") },
            Handling = new() { ["fMass"] = J("1620.5"), ["nInitialDriveGears"] = J("7"), ["vecCentreOfMassOffset"] = J("[0, 0.1, -0.2]") },
            Variation = new VariationView { Colors = new() { new[] { 1, 1, 0, 0 }, new[] { 0, 0, 0, 0 } }, LightSettings = 23 },
            Kits = new() { new KitView { Name = "2020_testcar_modkit", Id = 2020, Mods = new() { new ModView { Label = "TESTCAR_SPL2", TurnOff = new() } } } },
            Lights = new() { new LightView { File = @"common\data\carcols.meta", Id = 23 } },
        });
        var v = VehicleEditor.Read(pack, "testcar", game);
        Assert.Equal("G37S", v.Data["gameName"]);
        Assert.Equal(new[] { "FLAG_SPORTS" }, (string[])v.Data["flags"]);
        Assert.Equal(1620.5f, v.Handling.Fields["fMass"]);
        Assert.Equal(7, v.Handling.Fields["nInitialDriveGears"]);
        Assert.Equal(new[] { 0f, 0.1f, -0.2f }, (float[])v.Handling.Fields["vecCentreOfMassOffset"]);
        Assert.Equal(2, v.Variation.Colors.Count);
        Assert.Equal(new[] { 1, 1, 0, 0 }, v.Variation.Colors[0]);
        Assert.Equal(2020, v.Kits.Single().Id);
        Assert.Equal("TESTCAR_SPL2", v.Kits.Single().Mods.Single().Label);
        Assert.Empty(v.Kits.Single().Mods.Single().TurnOff);
        Assert.Equal(23, v.Lights.Single().Id);
        Assert.DoesNotContain(v.Issues, i => i.Severity == "error");

        // What the editor does not know is kept as it was.
        string vehicles = pack.ReadText(@"common\data\levels\gta5\vehicles.meta");
        Assert.Contains("<!-- a comment the editor must keep -->", vehicles);
        Assert.Contains("<customField value=\"42\" />", vehicles);
        Assert.Contains("<gameName>OTHER</gameName>", vehicles);
        Assert.Contains("      <gameName>G37S</gameName>\n", vehicles.Replace("\r\n", "\n"));
        Assert.Contains("<strModelFlags>440010</strModelFlags>", pack.ReadText(@"common\data\handling.meta"));
        Assert.True(File.Exists(pack.File + ".bak"), "the pack before the first change");
        Assert.Contains("<id value=\"950\" />", System.Text.Encoding.UTF8.GetString(Archives.Read(Archives.Find(Archives.Open(pack.File + ".bak", "bak", _ => { }), "carcols.meta"))));
    }

    [Fact]
    public void Handling_from_the_game_becomes_the_vehicles_own()
    {
        Assert.Throws<InvalidOperationException>(() =>
            VehicleEditor.Apply(pack, "othercar", new VehiclePatch { Handling = new() { ["fMass"] = J("1") } }));
        string name = VehicleEditor.OwnHandling(pack, "othercar", game);
        Assert.Equal("OTHERCAR", name);
        var v = VehicleEditor.Read(pack, "othercar", game);
        Assert.Equal("pack", v.Handling.Source);
        Assert.Equal("OTHERCAR", v.Data["handlingId"]);
        Assert.Equal(1700f, v.Handling.Fields["fMass"]);
        VehicleEditor.Apply(pack, "othercar", new VehiclePatch { Handling = new() { ["fMass"] = J("1800") } });
        Assert.Equal(1800f, VehicleEditor.Read(pack, "othercar", game).Handling.Fields["fMass"]);
        Assert.Equal(1500f, VehicleEditor.Read(pack, "testcar", game).Handling.Fields["fMass"]);
        Assert.Equal("OTHERCAR", VehicleEditor.OwnHandling(pack, "othercar", game));  // once
    }

    [Fact]
    public void A_pack_without_handling_gets_the_file_and_its_content_entry()
    {
        // A pack like g37s: vehicles.meta only.
        string src = Path.Combine(dir, "src");
        Directory.CreateDirectory(Path.Combine(src, "common", "data", "levels", "gta5"));
        File.Copy(Path.Combine(AppContext.BaseDirectory, "testdata", "pack", "content.xml"), Path.Combine(src, "content.xml"));
        File.Copy(Path.Combine(AppContext.BaseDirectory, "testdata", "pack", "setup2.xml"), Path.Combine(src, "setup2.xml"));
        File.Copy(Path.Combine(AppContext.BaseDirectory, "testdata", "pack", "common", "data", "levels", "gta5", "vehicles.meta"),
            Path.Combine(src, "common", "data", "levels", "gta5", "vehicles.meta"));
        Archives.Pack(src, Path.Combine(dir, "bare", "dlc.rpf"));
        var bare = AddonPack.List(dir).Single(p => p.Name == "bare");
        VehicleEditor.OwnHandling(bare, "othercar", game);
        Assert.Contains(@"common\data\handling.meta", bare.TextFiles());
        string content = bare.ReadText("content.xml");
        Assert.Contains("<filename>dlc_testcar:/common/data/handling.meta</filename>", content);
        Assert.Contains("<fileType>HANDLING_FILE</fileType>", content);
        Assert.Contains("<Item>dlc_testcar:/common/data/handling.meta</Item>", content);
        // What was there stays (lost, the game did not load the pack at all: g37s in the game).
        var xml = System.Xml.Linq.XDocument.Parse(content);
        Assert.Equal(new[] { "dlc_testcar:/common/data/levels/gta5/vehicles.meta", "dlc_testcar:/common/data/handling.meta" },
            xml.Root.Element("dataFiles").Elements("Item").Select(i => i.Element("filename").Value));
        Assert.Equal(new[] { "dlc_testcar:/common/data/levels/gta5/vehicles.meta", "dlc_testcar:/common/data/handling.meta" },
            xml.Descendants("filesToEnable").Single().Elements("Item").Select(i => i.Value));
        Assert.Equal("pack", VehicleEditor.Read(bare, "othercar", game).Handling.Source);
    }
}
