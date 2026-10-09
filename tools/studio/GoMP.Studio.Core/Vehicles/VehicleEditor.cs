// A vehicle of an add-on pack as the editor shows it (data, handling, colours,
// mod kits, lights) and changes to it written back into the pack's XML files.
using System.Globalization;
using System.Xml.Linq;

namespace GoMP.Studio.Vehicles;

public sealed record Issue(string Severity, string Field, string Message);

public sealed class HandlingView
{
    public string Name { get; set; }
    public string Source { get; set; }  // pack, game or missing
    public string File { get; set; }
    public Dictionary<string, object> Fields { get; set; } = new();
}

public sealed class VariationView
{
    public string File { get; set; }
    // In a patch a missing list (null) is left as it is.
    public List<int[]> Colors { get; set; }  // primary, secondary, pearl, wheels
    public List<string> Kits { get; set; }
    public int? LightSettings { get; set; }
    public int? SirenSettings { get; set; }
}

public sealed class ModView
{
    public string ModelName { get; set; }
    public string Label { get; set; }
    public string Type { get; set; }
    public string Bone { get; set; }
    public List<string> Linked { get; set; }
    public List<string> TurnOff { get; set; }
}

public sealed class KitView
{
    public string File { get; set; }
    public string Name { get; set; }
    public int Id { get; set; }
    public string Type { get; set; }
    public List<ModView> Mods { get; set; }
}

public sealed class LightView
{
    public string File { get; set; }
    public int Id { get; set; }
}

public sealed class VehicleView
{
    public string Pack { get; set; }
    public string Model { get; set; }
    public string VehiclesFile { get; set; }
    public Dictionary<string, object> Data { get; set; } = new();
    public HandlingView Handling { get; set; }
    public VariationView Variation { get; set; }
    public List<KitView> Kits { get; set; } = new();
    public List<LightView> Lights { get; set; } = new();
    public List<Issue> Issues { get; set; } = new();
}

// What the browser sends: only what changed.
public sealed class VehiclePatch
{
    public Dictionary<string, object> Data { get; set; }
    public Dictionary<string, object> Handling { get; set; }
    public VariationView Variation { get; set; }
    public List<KitView> Kits { get; set; }
    public List<LightView> Lights { get; set; }
}

public static class VehicleEditor
{
    private static string S(object v) => v switch
    {
        null => null,
        System.Text.Json.JsonElement j when j.ValueKind == System.Text.Json.JsonValueKind.String => j.GetString(),
        System.Text.Json.JsonElement j => j.ToString(),
        float f => MetaXml.F(f),
        double d => MetaXml.F((float)d),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture),
    };

    private static float[] Vec(object v) => v switch
    {
        float[] a => a,
        System.Text.Json.JsonElement j when j.ValueKind == System.Text.Json.JsonValueKind.Array => j.EnumerateArray().Select(x => x.GetSingle()).ToArray(),
        _ => null,
    };

    private static IEnumerable<string> Strings(object v) => v switch
    {
        IEnumerable<string> s => s,
        System.Text.Json.JsonElement j when j.ValueKind == System.Text.Json.JsonValueKind.Array => j.EnumerateArray().Select(x => x.GetString()),
        _ => Enumerable.Empty<string>(),
    };

    // ------------------------------------------------------------------ reading

    // The vehicles.meta <Item> of a model and its file.
    private static (string File, XDocument Doc, XElement Item) VehicleItem(AddonPack pack, string model)
    {
        foreach (string f in pack.FilesNamed("vehicles.meta"))
        {
            var doc = MetaXml.Parse(pack.ReadText(f));
            var item = doc.Descendants("Item").FirstOrDefault(i => string.Equals(MetaXml.Get(i, "modelName"), model, StringComparison.OrdinalIgnoreCase));
            if (item != null) return (f, doc, item);
        }
        return (null, null, null);
    }

    public static IEnumerable<(string Model, string GameName, string Make, string Class)> Models(AddonPack pack)
    {
        foreach (string f in pack.FilesNamed("vehicles.meta"))
        {
            var doc = MetaXml.Parse(pack.ReadText(f));
            foreach (var i in doc.Descendants("Item").Where(i => MetaXml.Child(i, "modelName") != null && MetaXml.Child(i, "handlingId") != null))
                yield return (MetaXml.Get(i, "modelName"), MetaXml.Get(i, "gameName"), MetaXml.Get(i, "vehicleMakeName"), MetaXml.Get(i, "vehicleClass"));
        }
    }

    private static (string File, XDocument Doc, XElement Item) HandlingItem(AddonPack pack, string name)
    {
        foreach (string f in pack.FilesNamed("handling.meta"))
        {
            var doc = MetaXml.Parse(pack.ReadText(f));
            var item = doc.Descendants("Item").FirstOrDefault(i => string.Equals(MetaXml.Get(i, "handlingName"), name, StringComparison.OrdinalIgnoreCase));
            if (item != null) return (f, doc, item);
        }
        return (null, null, null);
    }

    private static (string File, XDocument Doc, XElement Item) VariationItem(AddonPack pack, string model)
    {
        foreach (string f in pack.FilesNamed("carvariations.meta"))
        {
            var doc = MetaXml.Parse(pack.ReadText(f));
            var item = doc.Descendants("Item").FirstOrDefault(i => MetaXml.Child(i, "colors") != null &&
                                                                  string.Equals(MetaXml.Get(i, "modelName"), model, StringComparison.OrdinalIgnoreCase));
            if (item != null) return (f, doc, item);
        }
        return (null, null, null);
    }

    private static Dictionary<string, object> HandlingFields(XElement item)
    {
        var fields = new Dictionary<string, object>();
        foreach (var f in VehicleSchema.Handling)
        {
            if (f.Kind == FieldKind.Vec3) { if (MetaXml.GetVec(item, f.Name) is { } v) fields[f.Name] = v; }
            else if (MetaXml.GetFloat(item, f.Name) is { } x) fields[f.Name] = f.Kind == FieldKind.Int ? (object)(int)x : x;
        }
        return fields;
    }

    public static VehicleView Read(AddonPack pack, string model, GameVehicles game = null, IEnumerable<AddonPack> allPacks = null)
    {
        var (vf, _, item) = VehicleItem(pack, model);
        if (item == null) throw new KeyNotFoundException($"в паке {pack.Name} нет машины {model}");
        var view = new VehicleView { Pack = pack.Name, Model = MetaXml.Get(item, "modelName"), VehiclesFile = vf };
        foreach (var f in VehicleSchema.Data)
        {
            string v = MetaXml.Get(item, f.Name);
            view.Data[f.Name] = f.Kind == FieldKind.Flags ? (v ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries) : v;
        }

        string handlingId = MetaXml.Get(item, "handlingId");
        var (hf, _, hitem) = HandlingItem(pack, handlingId ?? "");
        if (hitem != null)
        {
            view.Handling = new HandlingView { Name = handlingId, Source = "pack", File = hf, Fields = HandlingFields(hitem) };
        }
        else if (game != null && handlingId != null && game.Handling.TryGetValue(handlingId, out var xml))
        {
            view.Handling = new HandlingView { Name = handlingId, Source = "game", Fields = HandlingFields(XElement.Parse(xml)) };
        }
        else
        {
            view.Handling = new HandlingView { Name = handlingId, Source = "missing" };
        }

        var (cf, _, vitem) = VariationItem(pack, view.Model);
        if (vitem != null)
        {
            var v = new VariationView { File = cf, Colors = new() };
            foreach (var c in MetaXml.Child(vitem, "colors").Elements("Item"))
                v.Colors.Add(MetaXml.Ints(c.Element("indices")?.Value).Concat(new[] { 0, 0, 0, 0 }).Take(4).ToArray());
            v.Kits = MetaXml.Child(vitem, "kits")?.Elements("Item").Select(k => k.Value.Trim()).ToList() ?? new();
            v.LightSettings = int.TryParse(MetaXml.Get(vitem, "lightSettings"), out int ls) ? ls : null;
            v.SirenSettings = int.TryParse(MetaXml.Get(vitem, "sirenSettings"), out int ss) ? ss : null;
            view.Variation = v;
        }

        // Kits of this pack used by the vehicle, and the pack's light settings.
        var kitNames = new HashSet<string>(view.Variation?.Kits ?? new(), StringComparer.OrdinalIgnoreCase);
        foreach (string f in pack.FilesNamed("carcols.meta"))
        {
            var doc = MetaXml.Parse(pack.ReadText(f));
            var kits = doc.Root?.Element("Kits");
            foreach (var k in kits?.Elements("Item") ?? Enumerable.Empty<XElement>())
            {
                string name = MetaXml.Get(k, "kitName");
                if (!kitNames.Contains(name ?? "")) continue;
                var kit = new KitView { File = f, Name = name, Id = int.TryParse(MetaXml.Get(k, "id"), out int id) ? id : 0, Type = MetaXml.Get(k, "kitType"), Mods = new() };
                foreach (var m in MetaXml.Child(k, "visibleMods")?.Elements("Item") ?? Enumerable.Empty<XElement>())
                    kit.Mods.Add(new ModView
                    {
                        ModelName = MetaXml.Get(m, "modelName"), Label = MetaXml.Get(m, "modShopLabel"), Type = MetaXml.Get(m, "type"),
                        Bone = MetaXml.Get(m, "bone"),
                        Linked = MetaXml.Child(m, "linkedModels")?.Elements("Item").Select(x => x.Value.Trim()).ToList() ?? new(),
                        TurnOff = MetaXml.Child(m, "turnOffBones")?.Elements("Item").Select(x => x.Value.Trim()).ToList() ?? new(),
                    });
                view.Kits.Add(kit);
            }
            foreach (var l in doc.Root?.Element("Lights")?.Elements("Item") ?? Enumerable.Empty<XElement>())
                if (int.TryParse(MetaXml.Get(l, "id"), out int lid)) view.Lights.Add(new LightView { File = f, Id = lid });
        }
        view.Issues = Check(view, game, OtherKitIds(pack, allPacks));
        return view;
    }

    // Kit ids of the other packs (two packs must not share one).
    private static HashSet<int> OtherKitIds(AddonPack pack, IEnumerable<AddonPack> all)
    {
        var ids = new HashSet<int>();
        foreach (var p in all ?? Enumerable.Empty<AddonPack>())
        {
            if (p.File == pack.File) continue;
            foreach (string f in p.FilesNamed("carcols.meta"))
                foreach (var k in MetaXml.Parse(p.ReadText(f)).Root?.Element("Kits")?.Elements("Item") ?? Enumerable.Empty<XElement>())
                    if (int.TryParse(MetaXml.Get(k, "id"), out int id)) ids.Add(id);
        }
        return ids;
    }

    // ------------------------------------------------------------------ checking

    public static List<Issue> Check(VehicleView v, GameVehicles game, HashSet<int> otherKits = null)
    {
        var issues = new List<Issue>();
        void Err(string field, string m) => issues.Add(new Issue("error", field, m));
        void Warn(string field, string m) => issues.Add(new Issue("warning", field, m));

        string gameName = v.Data.GetValueOrDefault("gameName") as string;
        if (string.IsNullOrWhiteSpace(gameName)) Warn("gameName", "нет названия: в игре будет имя модели");
        else if (gameName.Length > 11) Warn("gameName", "название длиннее 11 символов — игра его обрежет");
        if (v.Data.GetValueOrDefault("vehicleClass") is string cls && cls.Length > 0 && !VehicleSchema.Classes.Contains(cls)) Warn("vehicleClass", $"неизвестный класс {cls}");
        if (v.Handling.Source == "missing") Err("handlingId", $"нет записи {v.Handling.Name} ни в паке, ни в игре");
        if (game != null && v.Data.GetValueOrDefault("audioNameHash") is string audio && audio.Length > 0 &&
            !game.Models.Contains(audio) && !string.Equals(audio, v.Model, StringComparison.OrdinalIgnoreCase))
            Warn("audioNameHash", $"в игре нет машины {audio}: звука не будет");

        foreach (var f in VehicleSchema.Handling)
        {
            if (!v.Handling.Fields.TryGetValue(f.Name, out var val) || double.IsNaN(f.Min)) continue;
            var nums = val is float[] a ? a.Select(x => (double)x) : new[] { Convert.ToDouble(val, CultureInfo.InvariantCulture) };
            if (nums.Any(x => x < f.Min || x > f.Max)) Warn("handling." + f.Name, $"{f.Label}: вне обычных значений ({f.Min}…{f.Max})");
        }

        foreach (var k in v.Kits)
        {
            if (game != null && game.KitIds.Contains(k.Id)) Err("kit." + k.Name, $"id набора тюнинга {k.Id} уже занят игрой — тюнинг будет чужим");
            if (otherKits != null && otherKits.Contains(k.Id)) Err("kit." + k.Name, $"id набора тюнинга {k.Id} уже есть в другом паке");
        }
        foreach (var l in v.Lights)
        {
            int real = l.Id & 0xFF;
            if (l.Id > 255) Warn("light." + l.Id, $"id света {l.Id} больше 255: игра берёт {real}");
            if (game != null && game.LightIds.Contains(real)) Err("light." + l.Id, $"id света {real} уже занят игрой — фары будут чужими");
        }
        if (v.Variation?.LightSettings is int vl && v.Lights.Count > 0 && !v.Lights.Any(l => (l.Id & 0xFF) == (vl & 0xFF)) &&
            !(game?.LightIds.Contains(vl & 0xFF) ?? false))
            Warn("variation.lightSettings", $"настройки света {vl} нет ни в паке, ни в игре");
        // Colour numbers: the base palette has 161, DLCs add more; a byte in the game.
        foreach (var c in v.Variation?.Colors ?? new())
            if (c.Any(i => i < 0 || i > 255)) Warn("variation.colors", $"цвет {string.Join(" ", c)}: номера от 0 до 255");
        return issues;
    }

    // ------------------------------------------------------------------ writing

    public static void Apply(AddonPack pack, string model, VehiclePatch patch)
    {
        var (vf, vdoc, item) = VehicleItem(pack, model);
        if (item == null) throw new KeyNotFoundException($"в паке {pack.Name} нет машины {model}");

        if (patch.Data != null)
        {
            foreach (var (name, value) in patch.Data)
            {
                var f = VehicleSchema.DataField(name) ?? throw new ArgumentException($"поле {name} не редактируется");
                string text = f.Kind == FieldKind.Flags ? string.Join(" ", Strings(value)) : S(value) ?? "";
                MetaXml.Set(item, name, text, asAttribute: false);
            }
            pack.WriteText(vf, MetaXml.Write(vdoc));
        }

        if (patch.Handling != null && patch.Handling.Count > 0)
        {
            string handlingId = MetaXml.Get(item, "handlingId");
            var (hf, hdoc, hitem) = HandlingItem(pack, handlingId);
            if (hitem == null) throw new InvalidOperationException("характеристики берутся из игры: сначала сделайте свою запись handling");
            foreach (var (name, value) in patch.Handling)
            {
                var f = VehicleSchema.HandlingField(name) ?? throw new ArgumentException($"поле {name} не редактируется");
                if (f.Kind == FieldKind.Vec3) MetaXml.SetVec(hitem, name, Vec(value));
                else MetaXml.Set(hitem, name, f.Kind == FieldKind.Int ? ((int)Math.Round(double.Parse(S(value), CultureInfo.InvariantCulture))).ToString(CultureInfo.InvariantCulture)
                                                                       : MetaXml.F(float.Parse(S(value), CultureInfo.InvariantCulture)), asAttribute: true);
            }
            pack.WriteText(hf, MetaXml.Write(hdoc));
        }

        if (patch.Variation != null)
        {
            var (cf, cdoc, vitem) = VariationItem(pack, MetaXml.Get(item, "modelName"));
            if (vitem == null) throw new InvalidOperationException("у машины нет carvariations.meta");
            var v = patch.Variation;
            if (v.Colors != null) SetColors(MetaXml.Child(vitem, "colors"), v.Colors);
            if (v.Kits != null) MetaXml.SetList(MetaXml.Child(vitem, "kits"), v.Kits.Select(k => new XElement("Item", k)));
            if (v.LightSettings is int ls) MetaXml.Set(vitem, "lightSettings", ls.ToString(CultureInfo.InvariantCulture), asAttribute: true);
            if (v.SirenSettings is int ss) MetaXml.Set(vitem, "sirenSettings", ss.ToString(CultureInfo.InvariantCulture), asAttribute: true);
            pack.WriteText(cf, MetaXml.Write(cdoc));
        }

        if (patch.Kits != null || patch.Lights != null)
            foreach (string f in pack.FilesNamed("carcols.meta"))
            {
                var doc = MetaXml.Parse(pack.ReadText(f));
                bool changed = false;
                foreach (var k in patch.Kits ?? new())
                {
                    var el = doc.Root?.Element("Kits")?.Elements("Item").FirstOrDefault(x => string.Equals(MetaXml.Get(x, "kitName"), k.Name, StringComparison.OrdinalIgnoreCase));
                    if (el == null) continue;
                    MetaXml.Set(el, "id", k.Id.ToString(CultureInfo.InvariantCulture), asAttribute: true);
                    if (k.Mods != null) SetMods(MetaXml.Child(el, "visibleMods"), k.Mods);
                    changed = true;
                }
                // Lights: by position in the file (the id is what changes).
                var lights = doc.Root?.Element("Lights")?.Elements("Item").ToList() ?? new();
                var ours = (patch.Lights ?? new()).Where(l => l.File == f).ToList();
                for (int i = 0; i < ours.Count && i < lights.Count; i++)
                {
                    MetaXml.Set(lights[i], "id", ours[i].Id.ToString(CultureInfo.InvariantCulture), asAttribute: true);
                    changed = true;
                }
                if (changed) pack.WriteText(f, MetaXml.Write(doc));
            }
    }

    private static void SetColors(XElement colors, List<int[]> list)
    {
        var items = colors.Elements("Item").ToList();
        var template = items.LastOrDefault();
        var result = new List<XElement>();
        for (int i = 0; i < list.Count; i++)
        {
            var it = i < items.Count ? new XElement(items[i]) : template != null ? new XElement(template) : new XElement("Item", new XElement("indices", new XAttribute("content", "char_array")));
            var ind = it.Element("indices");
            string indent = MetaXml.IndentOf(ind) + "  ";
            ind.Value = MetaXml.ArrayText(list[i].Select(n => n.ToString("000", CultureInfo.InvariantCulture)), indent.TrimStart('\n'));
            result.Add(it);
        }
        MetaXml.SetList(colors, result);
    }

    private static void SetMods(XElement visibleMods, List<ModView> mods)
    {
        if (visibleMods == null) return;
        var items = visibleMods.Elements("Item").ToList();
        var result = new List<XElement>();
        for (int i = 0; i < mods.Count; i++)
        {
            var m = mods[i];
            var it = i < items.Count ? new XElement(items[i]) : items.Count > 0 ? new XElement(items[^1]) : null;
            if (it == null) continue;
            if (m.ModelName != null) MetaXml.Set(it, "modelName", m.ModelName, false);
            if (m.Label != null) MetaXml.Set(it, "modShopLabel", m.Label, false);
            if (m.Type != null) MetaXml.Set(it, "type", m.Type, false);
            if (m.Bone != null) MetaXml.Set(it, "bone", m.Bone, false);
            if (m.Linked != null && MetaXml.Child(it, "linkedModels") is { } lm) MetaXml.SetList(lm, m.Linked.Select(x => new XElement("Item", x)));
            if (m.TurnOff != null && MetaXml.Child(it, "turnOffBones") is { } tb) MetaXml.SetList(tb, m.TurnOff.Select(x => new XElement("Item", x)));
            result.Add(it);
        }
        MetaXml.SetList(visibleMods, result);
    }

    // ------------------------------------------------------------------ own handling

    // Copies the game's handling entry into the pack under the model's name
    // (handling.meta and content.xml as needed) and points the vehicle at it.
    public static string OwnHandling(AddonPack pack, string model, GameVehicles game)
    {
        var (vf, vdoc, item) = VehicleItem(pack, model);
        if (item == null) throw new KeyNotFoundException($"в паке {pack.Name} нет машины {model}");
        string from = MetaXml.Get(item, "handlingId");
        if (HandlingItem(pack, from).Item != null) return from;  // already the pack's own
        if (game == null || !game.Handling.TryGetValue(from ?? "", out var xml)) throw new InvalidOperationException($"в игре нет записи handling {from}");
        string name = model.ToUpperInvariant();
        var entry = XElement.Parse(xml);
        entry.Element("handlingName").Value = name;

        string file = pack.FilesNamed("handling.meta").FirstOrDefault();
        XDocument doc;
        if (file == null)
        {
            file = @"common\data\handling.meta";
            doc = MetaXml.Parse("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CHandlingDataMgr>\n  <HandlingData>\n  </HandlingData>\n</CHandlingDataMgr>");
            AddContentEntry(pack, file, "HANDLING_FILE");
        }
        else
        {
            doc = MetaXml.Parse(pack.ReadText(file));
        }
        var list = doc.Root.Element("HandlingData") ?? throw new InvalidDataException("handling.meta без HandlingData");
        string indent = MetaXml.IndentOf(list.Elements().FirstOrDefault()) ?? MetaXml.IndentOf(list) + "  ";
        var last = list.Nodes().LastOrDefault();
        if (last is XText t && string.IsNullOrWhiteSpace(t.Value)) t.AddBeforeSelf(new XText("\n" + indent), entry);
        else list.Add(new XText("\n" + indent), entry, new XText("\n" + MetaXml.IndentOf(list)));
        pack.WriteText(file, MetaXml.Write(doc));
        MetaXml.Set(item, "handlingId", name, asAttribute: false);
        pack.WriteText(vf, MetaXml.Write(vdoc));
        return name;
    }

    // A data file in content.xml, enabled with the pack's first change set.
    private static void AddContentEntry(AddonPack pack, string inner, string fileType)
    {
        string device = "dlc_" + pack.Name;
        if (pack.TryFind("setup2.xml") is { } setup)
        {
            var s = XDocument.Parse(pack.ReadText(AddonPack.Inner(setup)));
            device = s.Root?.Element("deviceName")?.Value.Trim() ?? device;
        }
        string path = $"{device}:/{inner.Replace('\\', '/')}";
        string contentFile = AddonPack.Inner(pack.TryFind("content.xml") ?? throw new InvalidDataException("в паке нет content.xml"));
        var doc = MetaXml.Parse(pack.ReadText(contentFile));
        var dataFiles = doc.Root.Element("dataFiles");
        if (dataFiles.Elements("Item").Any(i => string.Equals(i.Element("filename")?.Value.Trim(), path, StringComparison.OrdinalIgnoreCase))) return;
        var item = new XElement("Item",
            new XElement("filename", path), new XElement("fileType", fileType),
            new XElement("locked", new XAttribute("value", "false")), new XElement("disabled", new XAttribute("value", "true")),
            new XElement("persistent", new XAttribute("value", "true")), new XElement("overlay", new XAttribute("value", "true")));
        MetaXml.SetList(dataFiles, dataFiles.Elements("Item").Select(e => new XElement(e)).Append(item));
        var enable = doc.Root.Element("contentChangeSets")?.Elements("Item").FirstOrDefault()?.Element("filesToEnable");
        if (enable != null) MetaXml.SetList(enable, enable.Elements("Item").Select(e => new XElement(e)).Append(new XElement("Item", path)));
        pack.WriteText(contentFile, MetaXml.Write(doc));
    }
}
