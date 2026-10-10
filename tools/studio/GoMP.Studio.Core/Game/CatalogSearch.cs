// Search and categories of the model catalog. Pure and independent of the game
// files (works on ArchetypeInfo lists), so it is tested on synthetic data. The
// index is built once at load: tokens and category bits are precomputed, a
// search is then one pass over the name-sorted entries.
using System.Globalization;

namespace GoMP.Studio.Game;

public sealed record CatalogCategory(string Id, string Label, string[] Keywords, string[] YtypPrefixes);

public sealed record CatalogPage(int Total, List<ArchetypeInfo> Items);

public sealed class CatalogIndex
{
    private sealed class Entry
    {
        public ArchetypeInfo Info;
        public string Name;       // lower case; null when the name is unknown
        public string Ytyp;       // lower case or ""
        public string[] Tokens;
        public string[] Segments; // the name split on '_' only ("01a" stays whole)
        public int Categories;    // bit i: CatalogSearch.Categories[i]
    }

    private readonly List<Entry> named = new();    // props first, then by name (ordinal)
    private readonly List<Entry> unnamed = new();  // by hash
    private readonly Dictionary<uint, Entry> byHash = new();

    // Models of each category (without interiors), named and unnamed.
    public int[] CategoryCounts { get; }
    public int NamedCount => named.Count;
    public int UnnamedCount => unnamed.Count;

    public CatalogIndex(IEnumerable<ArchetypeInfo> items)
    {
        var cats = CatalogSearch.Categories;
        CategoryCounts = new int[cats.Count];
        foreach (var info in items)
        {
            var e = new Entry { Info = info, Ytyp = (info.Ytyp ?? "").ToLowerInvariant() };
            var tokens = new List<string>();
            if (info.Name != null)
            {
                e.Name = info.Name.ToLowerInvariant();
                e.Tokens = CatalogSearch.Tokens(e.Name);
                e.Segments = e.Name.Split('_', StringSplitOptions.RemoveEmptyEntries);
                tokens.AddRange(e.Tokens);
            }
            tokens.AddRange(CatalogSearch.Tokens(e.Ytyp));
            for (int i = 0; i < cats.Count; i++)
                if (CatalogSearch.InCategory(cats[i], tokens, e.Ytyp)) e.Categories |= 1 << i;
            if (info.Kind != "interior")
                for (int i = 0; i < cats.Count; i++)
                    if ((e.Categories & (1 << i)) != 0) CategoryCounts[i]++;
            (e.Name != null ? named : unnamed).Add(e);
            byHash[info.Hash] = e;
        }
        // Props are what maps are built from; "ar_prop_..", "02gate3_l" and other
        // helper models of DLCs come after them within the same relevance.
        named.Sort((a, b) =>
        {
            int pa = a.Name.StartsWith("prop_", StringComparison.Ordinal) ? 0 : 1, pb = b.Name.StartsWith("prop_", StringComparison.Ordinal) ? 0 : 1;
            return pa != pb ? pa - pb : string.CompareOrdinal(a.Name, b.Name);
        });
        unnamed.Sort((a, b) => a.Info.Hash.CompareTo(b.Info.Hash));
    }

    public CatalogPage Search(string query, string category, int offset, int limit, bool interiors)
    {
        limit = Math.Clamp(limit, 1, 500);
        offset = Math.Max(offset, 0);
        query = (query ?? "").Trim().ToLowerInvariant();
        int catBit = 0;
        if (!string.IsNullOrEmpty(category))
        {
            int idx = -1;
            for (int i = 0; i < CatalogSearch.Categories.Count; i++)
                if (CatalogSearch.Categories[i].Id == category) idx = i;
            if (idx < 0) return new CatalogPage(0, new());  // unknown category: nothing
            catBit = 1 << idx;
        }
        bool Allowed(Entry e) => (interiors || e.Info.Kind != "interior") && (catBit == 0 || (e.Categories & catBit) != 0);

        // A hash ("0x1A2B3C4D" or a decimal number) finds the exact archetype, named or not.
        if (CatalogSearch.TryParseHash(query, out uint hash) && byHash.TryGetValue(hash, out var exact) && Allowed(exact))
            return Slice(new List<Entry> { exact }, offset, limit);

        var words = query.Split(new[] { ' ', '_' }, StringSplitOptions.RemoveEmptyEntries);
        var buckets = new List<Entry>[4];
        for (int i = 0; i < 4; i++) buckets[i] = new();
        foreach (var e in named)
        {
            if (!Allowed(e)) continue;
            int score = words.Length == 0 ? 0 : CatalogSearch.Score(e.Name, e.Tokens, e.Segments, e.Ytyp, query, words);
            if (score >= 0) buckets[score].Add(e);
        }
        var all = buckets[0];
        for (int i = 1; i < 4; i++) all.AddRange(buckets[i]);
        // The unnamed have nothing to match a word against: only category browsing lists them.
        if (words.Length == 0 && catBit != 0)
            foreach (var e in unnamed) if (Allowed(e)) all.Add(e);
        return Slice(all, offset, limit);
    }

    private static CatalogPage Slice(List<Entry> all, int offset, int limit) =>
        new(all.Count, all.Skip(offset).Take(limit).Select(e => e.Info).ToList());
}

public static class CatalogSearch
{
    // Keywords match inside a token ("gate" in "facgate"); "=word" must equal a token.
    public static readonly IReadOnlyList<CatalogCategory> Categories = new[]
    {
        new CatalogCategory("fences", "Заборы и ворота", new[] { "fnc", "fence", "gate", "railing" }, new[] { "v_fences" }),
        new CatalogCategory("walls", "Стены, блоки, барьеры", new[] { "wall", "barrier", "barier", "block", "jersey", "conc", "bollard" }, Array.Empty<string>()),
        new CatalogCategory("doors", "Двери, гаражи, ставни", new[] { "door", "garage", "shutter" }, Array.Empty<string>()),
        new CatalogCategory("construction", "Стройка", new[] { "const", "scaffold", "plank", "pipe", "girder" }, new[] { "v_construction" }),
        new CatalogCategory("storage", "Контейнеры, ящики, паллеты", new[] { "container", "crate", "pallet", "=box" }, Array.Empty<string>()),
        new CatalogCategory("seating", "Скамейки, стулья, столы", new[] { "bench", "chair", "seat", "sofa", "couch", "table", "stool" }, Array.Empty<string>()),
        new CatalogCategory("lights", "Свет и фонари", new[] { "light", "lamp" }, Array.Empty<string>()),
        new CatalogCategory("signs", "Знаки и вывески", new[] { "sign", "billboard" }, Array.Empty<string>()),
        new CatalogCategory("plants", "Деревья и растения", new[] { "tree", "plant", "bush", "flower", "veg" }, Array.Empty<string>()),
        new CatalogCategory("stunts", "Рампы и трюки", new[] { "ramp", "stunt", "tyre", "=tire", "cone" }, Array.Empty<string>()),
        new CatalogCategory("rubbish", "Мусор и баки", new[] { "=bin", "=rub", "trash", "dumpster", "=skip" }, Array.Empty<string>()),
        new CatalogCategory("furniture", "Мебель и интерьер", new[] { "=bed", "shelf", "cabinet", "desk", "=tv", "couch", "wardrobe" }, new[] { "v_int", "v_res" }),
    };

    // "prop_fnclink_02gate1" -> prop, fnclink, 02, gate, 1 (lower case; split on
    // '_' and wherever letters meet digits).
    public static string[] Tokens(string name)
    {
        var list = new List<string>();
        if (string.IsNullOrEmpty(name)) return Array.Empty<string>();
        var sb = new System.Text.StringBuilder();
        foreach (char raw in name)
        {
            char c = char.ToLowerInvariant(raw);
            if (c == '_' || char.IsWhiteSpace(c)) { Flush(); continue; }
            if (sb.Length > 0 && char.IsDigit(c) != char.IsDigit(sb[^1])) Flush();
            sb.Append(c);
        }
        Flush();
        return list.ToArray();

        void Flush()
        {
            if (sb.Length > 0) list.Add(sb.ToString());
            sb.Clear();
        }
    }

    internal static bool InCategory(CatalogCategory cat, List<string> tokens, string ytyp)
    {
        foreach (var p in cat.YtypPrefixes)
            if (ytyp.StartsWith(p, StringComparison.Ordinal)) return true;
        foreach (var k in cat.Keywords)
            foreach (var t in tokens)
                if (k[0] == '=' ? t == k.Substring(1) : t.Contains(k, StringComparison.Ordinal)) return true;
        return false;
    }

    // "0x1A2B3C4D" or a decimal number.
    public static bool TryParseHash(string s, out uint hash)
    {
        hash = 0;
        if (string.IsNullOrEmpty(s)) return false;
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return uint.TryParse(s.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out hash);
        return s.All(char.IsDigit) && uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out hash);
    }

    // 0: the name is the query; 1: every word is a token; 2: every word starts or
    // ends a token; 3: every word is somewhere in the name or the ytyp; -1: no
    // match. Lower is better. name/query are lower case, words are non-empty.
    public static int Score(string name, string[] tokens, string[] segments, string ytyp, string query, string[] words)
    {
        if (name == query) return 0;
        int worst = 1;
        foreach (var w in words)
        {
            int level = 4;
            foreach (var t in tokens) if (t == w) { level = 1; break; }
            if (level > 1) foreach (var s in segments) if (s == w) { level = 1; break; }
            if (level > 2)
            {
                foreach (var t in tokens)
                    if (t.StartsWith(w, StringComparison.Ordinal) || t.EndsWith(w, StringComparison.Ordinal)) { level = 2; break; }
                if (level > 2)
                    foreach (var s in segments)
                        if (s.StartsWith(w, StringComparison.Ordinal) || s.EndsWith(w, StringComparison.Ordinal)) { level = 2; break; }
            }
            if (level > 3 && (name.Contains(w, StringComparison.Ordinal) || ytyp.Contains(w, StringComparison.Ordinal))) level = 3;
            if (level > 3) return -1;
            if (level > worst) worst = level;
        }
        return worst;
    }

    // One-off search over a list (tests, small lists); the game keeps a CatalogIndex.
    public static (int Total, List<ArchetypeInfo> Items) Search(IEnumerable<ArchetypeInfo> items, string query, string category, int offset, int limit, bool interiors)
    {
        var page = new CatalogIndex(items).Search(query, category, offset, limit, interiors);
        return (page.Total, page.Items);
    }
}
