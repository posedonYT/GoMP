// What the game itself has, for the vehicle editor: the handling entries of
// all vehicles (to copy one into a pack), the ids of mod kits and light
// settings (an add-on pack must not reuse them: lada2107's kit 950 and m5's
// 1270 did), the paint palette with names and the vehicle model names (engine
// sounds). Read once from the game files.
using System.Xml.Linq;
using CodeWalker.GameFiles;

namespace GoMP.Studio.Vehicles;

public sealed record PaintColor(int Index, string Name, string Rgb);

public sealed class GameVehicles
{
    public Dictionary<string, string> Handling { get; } = new(StringComparer.OrdinalIgnoreCase);  // name -> <Item> XML
    public HashSet<int> KitIds { get; } = new();
    public HashSet<int> LightIds { get; } = new();
    public List<PaintColor> Palette { get; } = new();
    public HashSet<string> Models { get; } = new(StringComparer.OrdinalIgnoreCase);

    public static GameVehicles Load(GameFileCache cache)
    {
        var g = new GameVehicles();
        foreach (var rpf in cache.AllRpfs ?? new List<RpfFile>())
        {
            // The mods folder holds the add-on packs themselves (gomp-addons install): not the game.
            if (rpf.AllEntries == null || rpf.Path.StartsWith(@"mods\", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var e in rpf.AllEntries.OfType<RpfFileEntry>())
            {
                try
                {
                    if (e.NameLower == "handling.meta") g.AddHandling(System.Text.Encoding.UTF8.GetString(rpf.ExtractFile(e)));
                    else if (e.NameLower == "carcols.ymt" || e.NameLower == "carcols.meta") g.AddCarcols(rpf.ExtractFile(e), e);
                }
                catch (Exception)
                {
                    // a broken file of the game: skipped
                }
            }
        }
        foreach (var v in cache.VehiclesInitDict?.Values ?? Enumerable.Empty<VehicleInitData>())
            if (!string.IsNullOrEmpty(v.modelName)) g.Models.Add(v.modelName);
        return g;
    }

    public void AddHandling(string xml)
    {
        var doc = XDocument.Parse(xml.TrimStart('﻿'));
        foreach (var item in doc.Descendants("Item").Where(i => i.Element("handlingName") != null))
            Handling[item.Element("handlingName").Value.Trim()] = item.ToString(SaveOptions.DisableFormatting);
    }

    private void AddCarcols(byte[] data, RpfFileEntry entry)
    {
        var f = new CarColsFile();
        f.Load(data, entry);
        var info = f.VehicleModelInfo;
        if (info == null) return;
        foreach (var k in info.Kits ?? Array.Empty<CVehicleKit>()) KitIds.Add(k.id);
        foreach (var l in info.Lights ?? Array.Empty<vehicleLightSettings>()) LightIds.Add(l.id);
        // The palette: the largest list of colours (the base game's carcols.ymt).
        if (info.Colors != null && info.Colors.Length > Palette.Count)
        {
            Palette.Clear();
            for (int i = 0; i < info.Colors.Length; i++)
            {
                uint argb = info.Colors[i].color;
                Palette.Add(new PaintColor(i, (info.Colors[i].colorName ?? $"#{i}").Trim(), $"#{argb & 0xFFFFFF:x6}"));
            }
        }
    }
}
