// Text patches of the game's data files (no archive access, covered by `gomp-addons selftest`).
using System.Text;
using System.Text.RegularExpressions;

namespace GoMP.Addons;

internal static class Patches
{
    // gameconfig.xml limits raised in the session copy of update.rpf.
    //
    // MaxExtraVehicleModelInfos sizes the pool of model infos of vehicles that come
    // from DLC packs (objects of 0x5A0 bytes, key 0xF000 in the game's pool map).
    // Build 3889 sets it to 640 and its own DLCs take 637 of them, so the fourth
    // add-on vehicle overflowed the pool: the game allocates the next slot without
    // a bounds check and crashed while loading (GTA5.exe+0x6057e1, reading a vtable
    // past the end of the array). 1024 leaves room for hundreds of add-on vehicles.
    public static readonly (string Name, int Minimum)[] ConfigLimits =
    {
        ("MaxExtraVehicleModelInfos", 1024),
    };

    // Adds <Item>dlcpacks:/pack/</Item> lines before </Paths> for packs not listed yet.
    public static string AddPacks(string xml, IEnumerable<string> packs)
    {
        int end = xml.LastIndexOf("</Paths>", StringComparison.OrdinalIgnoreCase);
        if (end < 0) throw new Exception("unexpected dlclist.xml format");
        var sb = new StringBuilder();
        foreach (string pack in packs)
            if (!xml.Contains($"dlcpacks:/{pack}/", StringComparison.OrdinalIgnoreCase))
                sb.Append($"\t\t<Item>dlcpacks:/{pack}/</Item>\r\n");
        return xml.Insert(end, sb.ToString());
    }

    // The value of <Name value="N"/> in gameconfig.xml, or -1.
    public static int LimitOf(string xml, string name)
    {
        var m = Regex.Match(xml, $@"<{Regex.Escape(name)}\s+value=""(\d+)""");
        return m.Success ? int.Parse(m.Groups[1].Value) : -1;
    }

    // Raises every limit of ConfigLimits to its minimum (a higher value is kept).
    public static string RaiseLimits(string xml)
    {
        foreach (var (name, minimum) in ConfigLimits)
        {
            var m = Regex.Match(xml, $@"<{Regex.Escape(name)}\s+value=""(\d+)""");
            if (!m.Success) throw new Exception($"gameconfig.xml has no {name}");
            var value = m.Groups[1];
            if (int.Parse(value.Value) >= minimum) continue;
            xml = xml.Substring(0, value.Index) + minimum + xml.Substring(value.Index + value.Length);
        }
        return xml;
    }

    // Model names declared in a vehicles.meta (what /veh takes).
    public static IEnumerable<string> ModelNames(string vehiclesMeta) =>
        Regex.Matches(vehiclesMeta, @"<modelName>\s*([^<\s]+)\s*</modelName>").Select(m => m.Groups[1].Value.ToLowerInvariant());

    // ------------------------------------------------------------------ selftest

    public static int SelfTest()
    {
        int failed = 0;
        void Check(string what, bool ok)
        {
            Console.WriteLine((ok ? "ok   " : "FAIL ") + what);
            if (!ok) failed++;
        }

        const string dlclist = "<SMandatoryPacksData>\r\n\t<Paths>\r\n\t\t<Item>dlcpacks:/mpbeach/</Item>\r\n\t</Paths>\r\n</SMandatoryPacksData>";
        string added = AddPacks(dlclist, new[] { "jesko", "mpbeach" });
        int jesko = added.IndexOf("<Item>dlcpacks:/jesko/</Item>", StringComparison.Ordinal);
        Check("AddPacks adds a new pack after the listed ones, before </Paths>",
              jesko > added.IndexOf("dlcpacks:/mpbeach/", StringComparison.Ordinal) && jesko < added.IndexOf("</Paths>", StringComparison.Ordinal));
        Check("AddPacks keeps a listed pack once", Regex.Matches(added, "dlcpacks:/mpbeach/").Count == 1);
        Check("AddPacks is idempotent", AddPacks(added, new[] { "jesko" }) == added);
        bool threw = false;
        try { AddPacks("<Paths>", new[] { "x" }); } catch { threw = true; }
        Check("AddPacks rejects a file without </Paths>", threw);

        const string config = "<ConfigModelInfo>\r\n  <MaxVehicleModelInfos value=\"320\"/>\r\n  <MaxExtraVehicleModelInfos value=\"640\"/>\r\n</ConfigModelInfo>";
        string raised = RaiseLimits(config);
        Check("RaiseLimits raises MaxExtraVehicleModelInfos to 1024", LimitOf(raised, "MaxExtraVehicleModelInfos") == 1024);
        Check("RaiseLimits leaves other limits alone", LimitOf(raised, "MaxVehicleModelInfos") == 320);
        Check("RaiseLimits keeps a higher value", LimitOf(RaiseLimits(config.Replace("640", "2000")), "MaxExtraVehicleModelInfos") == 2000);
        Check("RaiseLimits is idempotent", RaiseLimits(raised) == raised);
        threw = false;
        try { RaiseLimits("<ConfigModelInfo/>"); } catch { threw = true; }
        Check("RaiseLimits rejects a gameconfig without the limit", threw);

        const string meta = "<InitDatas><Item><modelName>Jesko</modelName></Item><Item><modelName> krga </modelName></Item></InitDatas>";
        Check("ModelNames reads model names in lower case", ModelNames(meta).SequenceEqual(new[] { "jesko", "krga" }));

        Console.WriteLine(failed == 0 ? "all tests passed" : $"{failed} test(s) failed");
        return failed == 0 ? 0 : 1;
    }
}
