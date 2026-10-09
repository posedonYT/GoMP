// An add-on vehicle pack (client-dist/addons/<pack>/dlc.rpf): its metadata files
// read and written in place (the archive is OPEN), with dlc.rpf.bak kept from
// before the first change. gomp-addons install copies a changed pack into the
// game's mods folder at the next launch.
using CodeWalker.GameFiles;
using GoMP.Gta;

namespace GoMP.Studio.Vehicles;

public sealed class AddonPack
{
    public string Name { get; }
    public string File { get; }

    public AddonPack(string file)
    {
        File = Path.GetFullPath(file);
        Name = Path.GetFileName(Path.GetDirectoryName(File));
    }

    public static IReadOnlyList<AddonPack> List(string addonsDir) =>
        Directory.Exists(addonsDir)
            ? Directory.GetDirectories(addonsDir).Select(d => Path.Combine(d, "dlc.rpf")).Where(System.IO.File.Exists)
                .Select(f => new AddonPack(f)).OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList()
            : new List<AddonPack>();

    public RpfFile Open() => Archives.Open(File, Name + "\\dlc.rpf", _ => { });

    // Path of an entry inside the pack: "common\data\handling.meta".
    public static string Inner(RpfFileEntry e)
    {
        string p = e.Path.Replace('/', '\\');
        int i = p.IndexOf("dlc.rpf\\", StringComparison.OrdinalIgnoreCase);
        return i >= 0 ? p[(i + 8)..] : p;
    }

    // The text (meta, xml) files of the pack.
    public IReadOnlyList<string> TextFiles()
    {
        var rpf = Open();
        return Archives.Files(rpf).Where(e => e.NameLower.EndsWith(".meta") || e.NameLower.EndsWith(".xml"))
            .Select(Inner).OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    // Files whose name is this (e.g. "vehicles.meta"), as inner paths.
    public IReadOnlyList<string> FilesNamed(string name) =>
        Archives.Files(Open()).Where(e => e.NameLower == name.ToLowerInvariant()).Select(Inner).ToList();

    public string ReadText(string inner) => System.Text.Encoding.UTF8.GetString(Archives.Read(Find(Open(), inner))).TrimStart('﻿');

    public byte[] ReadBytes(string inner) => Archives.Read(Find(Open(), inner));

    public RpfFileEntry TryFind(string suffix) => Archives.TryFind(Open(), suffix);

    // Writes a file of the pack (replacing it, or adding it with its folders).
    public void WriteText(string inner, string text)
    {
        Backup();
        var rpf = Open();
        var bytes = new System.Text.UTF8Encoding(false).GetBytes(text);
        var entry = Archives.TryFind(rpf, inner);
        if (entry != null) Archives.Replace(entry, bytes);
        else Archives.Write(rpf, inner, bytes);
    }

    private void Backup()
    {
        string bak = File + ".bak";
        if (!System.IO.File.Exists(bak)) System.IO.File.Copy(File, bak);
    }

    private static RpfFileEntry Find(RpfFile rpf, string inner)
    {
        // An exact path first (several vehicles.meta may exist), then by suffix.
        var exact = Archives.Files(rpf).FirstOrDefault(e => string.Equals(Inner(e), inner.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase));
        return exact ?? Archives.Find(rpf, inner);
    }
}
