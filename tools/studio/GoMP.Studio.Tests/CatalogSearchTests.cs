using GoMP.Studio.Game;
using GoMP.Studio.Maps;

namespace GoMP.Studio.Tests;

public sealed class CatalogSearchTests
{
    private static ArchetypeInfo A(string name, string ytyp = "props", string kind = "model", uint hash = 0) =>
        new(name, hash != 0 ? hash : (name == null ? 1u : Joaat.Hash(name)), new float[3], new float[3], 1f, 100f, kind, ytyp);

    private static readonly ArchetypeInfo[] Items =
    {
        A("prop_wall_vent_01"), A("prop_ld_wallet_01"), A("prop_wallbrick_01"),
        A("prop_fnclink_02gate1", "v_fences"), A("prop_fnclink_02gate2", "v_fences"), A("prop_facgate_01"),
        A("prop_gate_airport_01"), A("prop_fnclink_02a", "v_fences"), A("prop_bench_01a"),
        A("v_ilev_door_01", "v_interiors", "interior"),
        A(null, "v_fences", hash: 0x1A2B3C4D),
        A(null, "props_other", hash: 0x00000099),
    };

    private static List<string> Names(IEnumerable<ArchetypeInfo> l) => l.Select(a => a.Name ?? $"0x{a.Hash:X8}").ToList();

    [Fact]
    public void Tokens_split_on_underscores_and_digit_boundaries()
    {
        Assert.Equal(new[] { "prop", "fnclink", "02", "gate", "1" }, CatalogSearch.Tokens("prop_fnclink_02gate1"));
        Assert.Equal(new[] { "prop", "bench", "01", "a" }, CatalogSearch.Tokens("PROP_Bench_01a"));
        Assert.Empty(CatalogSearch.Tokens(""));
    }

    [Fact]
    public void A_whole_word_beats_a_word_start_so_wall_ranks_above_wallet()
    {
        var (total, found) = CatalogSearch.Search(Items, "wall", null, 0, 50, false);
        var names = Names(found);
        Assert.Equal(3, total);
        Assert.Equal("prop_wall_vent_01", names[0]);  // token (1) before prefixes (2)
        Assert.Equal(new[] { "prop_ld_wallet_01", "prop_wallbrick_01" }, names.Skip(1));
    }

    [Fact]
    public void A_word_inside_a_token_is_found_and_the_gate_family_stays_together()
    {
        var names = Names(CatalogSearch.Search(Items, "gate", null, 0, 50, false).Items);
        // facgate: "gate" ends a token (2); the two gate1/gate2 tokens are "gate"+"1" (1).
        Assert.Equal(new[] { "prop_fnclink_02gate1", "prop_fnclink_02gate2", "prop_gate_airport_01", "prop_facgate_01" }, names);
    }

    [Fact]
    public void The_exact_name_comes_first_and_the_ytyp_is_searchable()
    {
        Assert.Equal("prop_bench_01a", CatalogSearch.Search(Items, "prop_bench_01a", null, 0, 5, false).Items[0].Name);
        var byYtyp = Names(CatalogSearch.Search(Items, "v_fences", null, 0, 50, false).Items);
        Assert.Contains("prop_fnclink_02a", byYtyp);
        Assert.DoesNotContain("prop_bench_01a", byYtyp);
    }

    [Fact]
    public void Categories_take_keywords_from_names_and_ytyp_prefixes()
    {
        var fences = Names(CatalogSearch.Search(Items, "", "fences", 0, 50, false).Items);
        Assert.Contains("prop_facgate_01", fences);
        Assert.Contains("prop_fnclink_02a", fences);
        Assert.DoesNotContain("prop_bench_01a", fences);
        Assert.Equal(0, CatalogSearch.Search(Items, "", "nope", 0, 50, false).Total);
    }

    [Fact]
    public void Unnamed_models_are_only_in_category_browsing_and_hash_search()
    {
        // Browsing: named first, then the unnamed one whose ytyp is a fence ytyp.
        var fences = Names(CatalogSearch.Search(Items, "", "fences", 0, 50, false).Items);
        Assert.Equal("0x1A2B3C4D", fences[^1]);
        Assert.DoesNotContain("0x00000099", fences);
        // Words never match them; neither does the plain empty query.
        Assert.DoesNotContain("0x1A2B3C4D", Names(CatalogSearch.Search(Items, "fences", null, 0, 50, false).Items));
        Assert.DoesNotContain("0x1A2B3C4D", Names(CatalogSearch.Search(Items, "", null, 0, 50, false).Items));
        // A hash finds the exact archetype, hex or decimal.
        Assert.Equal(new[] { "0x1A2B3C4D" }, Names(CatalogSearch.Search(Items, "0x1a2b3c4d", null, 0, 50, false).Items));
        Assert.Equal(new[] { "0x00000099" }, Names(CatalogSearch.Search(Items, "153", null, 0, 50, false).Items));
        Assert.Equal(new[] { "prop_bench_01a" }, Names(CatalogSearch.Search(Items, Joaat.Hash("prop_bench_01a").ToString(), null, 0, 50, false).Items));
    }

    [Fact]
    public void Paging_reports_the_total_and_clamps_offset_and_limit()
    {
        var (total, first) = CatalogSearch.Search(Items, "fnc", null, 0, 2, false);
        Assert.Equal(3, total);
        Assert.Equal(2, first.Count);
        var (total2, second) = CatalogSearch.Search(Items, "fnc", null, 2, 2, false);
        Assert.Equal(3, total2);
        Assert.Single(second);
        Assert.Empty(CatalogSearch.Search(Items, "fnc", null, 99, 2, false).Items);
        Assert.Single(CatalogSearch.Search(Items, "fnc", null, -5, 1, false).Items);   // negative offset: 0
        Assert.Single(CatalogSearch.Search(Items, "fnc", null, 0, 0, false).Items);    // limit 0: at least 1
    }

    [Fact]
    public void Interiors_are_hidden_unless_asked_for()
    {
        Assert.Equal(0, CatalogSearch.Search(Items, "door", null, 0, 50, false).Total);
        Assert.Equal(1, CatalogSearch.Search(Items, "door", null, 0, 50, true).Total);
        var counts = new CatalogIndex(Items).CategoryCounts;
        Assert.Equal(0, counts[Array.FindIndex(CatalogSearch.Categories.ToArray(), c => c.Id == "doors")]);  // the interior is not counted
    }
}
