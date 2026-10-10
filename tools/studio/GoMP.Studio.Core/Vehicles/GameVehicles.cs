// What the game itself has, for the vehicle editor: the handling entries of
// all vehicles (to copy one into a pack), the ids of mod kits and light
// settings (an add-on pack must not reuse them: lada2107's kit 950 and m5's
// 1270 did), the paint palette with names and the vehicle model names (engine
// sounds). Read once from the game files.
using System.Xml.Linq;
using CodeWalker.GameFiles;

namespace GoMP.Studio.Vehicles;

public sealed record PaintColor(int Index, string Name, string Rgb);

// A vehicle of the game (vehicles.meta): what the dealership catalog is made from.
// Class: GET_VEHICLE_CLASS (VC_SPORT = 6...); Speed: fInitialDriveMaxFlatVel of its handling (km/h-ish).
public sealed record GameVehicle(string Model, string Make, string GameName, int Class, string Type, float Speed, string Flags);

public sealed class GameVehicles
{
    public Dictionary<string, string> Handling { get; } = new(StringComparer.OrdinalIgnoreCase);  // name -> <Item> XML
    public HashSet<int> KitIds { get; } = new();
    public HashSet<int> LightIds { get; } = new();
    public List<PaintColor> Palette { get; } = new();
    public HashSet<string> Models { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<GameVehicle> All { get; } = new();

    // vehicleClass of vehicles.meta -> GET_VEHICLE_CLASS.
    public static readonly string[] ClassNames =
    {
        "VC_COMPACT", "VC_SEDAN", "VC_SUV", "VC_COUPE", "VC_MUSCLE", "VC_SPORT_CLASSIC", "VC_SPORT", "VC_SUPER", "VC_MOTORCYCLE",
        "VC_OFF_ROAD", "VC_INDUSTRIAL", "VC_UTILITY", "VC_VAN", "VC_CYCLE", "VC_BOAT", "VC_HELICOPTER", "VC_PLANE", "VC_SERVICE",
        "VC_EMERGENCY", "VC_MILITARY", "VC_COMMERCIAL", "VC_RAIL", "VC_OPEN_WHEEL",
    };

    public static int ClassOf(string name) => Array.FindIndex(ClassNames, c => string.Equals(c, name?.Trim(), StringComparison.OrdinalIgnoreCase));

    // fInitialDriveMaxFlatVel of a handling entry (0 when there is none).
    public float SpeedOf(string handling)
    {
        if (string.IsNullOrEmpty(handling) || !Handling.TryGetValue(handling, out var xml)) return 0;
        var v = XElement.Parse(xml).Element("fInitialDriveMaxFlatVel")?.Attribute("value")?.Value;
        return float.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var f) ? f : 0;
    }

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
            if (!string.IsNullOrEmpty(v.modelName) && g.Models.Add(v.modelName))
                g.All.Add(new GameVehicle(v.modelName.ToLowerInvariant(), v.vehicleMakeName ?? "", v.gameName ?? "", ClassOf(v.vehicleClass),
                    v.type ?? "", g.SpeedOf(v.handlingId), string.Join(" ", v.flags ?? Array.Empty<string>())));
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
