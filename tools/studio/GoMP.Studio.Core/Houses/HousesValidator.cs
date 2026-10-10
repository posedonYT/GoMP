// What houses.js would skip (errors) and what looks wrong (warnings).
// The messages mirror those of houses.js validate().
using System.Text.RegularExpressions;
using GoMP.Studio.Maps;

namespace GoMP.Studio.Houses;

public static class HousesValidator
{
    private static readonly Regex IdRe = new(@"^[a-z0-9_-]{1,32}$");

    // knownModel: whether the game has the model (null: not checked).
    public static List<MapIssue> Check(HousesDocument doc, Func<uint, bool> knownModel = null)
    {
        var issues = new List<MapIssue>();
        void Error(string id, string m) => issues.Add(new MapIssue(Severity.Error, id, m));
        void Warn(string id, string m) => issues.Add(new MapIssue(Severity.Warning, id, m));

        if (doc.Format != HousesDocument.FormatName) Error(null, $"формат {doc.Format}, нужен {HousesDocument.FormatName}");
        if (doc.Version != HousesDocument.CurrentVersion) Error(null, $"версия {doc.Version}, нужна {HousesDocument.CurrentVersion}");

        var interiors = new HashSet<string>();
        foreach (var o in doc.Interiors ?? new())
        {
            string w = $"интерьер {o.Id}";
            if (!IdOk(o.Id)) { Error(o.Id, "интерьер: id — a-z, 0-9, _, - (до 32)"); continue; }
            if (!interiors.Add(o.Id)) { Error(o.Id, $"{w}: повторяется id"); continue; }
            if (string.IsNullOrWhiteSpace(o.Name)) Error(o.Id, $"{w}: нет названия");
            if (!Finite3(o.Spawn)) Error(o.Id, $"{w}: spawn — три числа");
            if (!Finite3(o.Exit)) Error(o.Id, $"{w}: exit — три числа");
            if (!double.IsFinite(o.Heading)) Error(o.Id, $"{w}: heading — число");
            if (Finite3(o.Spawn) && Finite3(o.Exit) && Dist(o.Spawn, o.Exit) > 25)
                Warn(o.Id, $"{w}: выход далеко от точки появления");
            var props = o.Props ?? new();
            if (props.Count > HousesDocument.MaxProps) Error(o.Id, $"{w}: больше {HousesDocument.MaxProps} предметов");
            var propIds = new HashSet<string>();
            for (int j = 0; j < props.Count; j++)
            {
                var p = props[j];
                string pw = $"{w}, предмет {j}";
                if (p.Model.Name != null && p.Model.Name.Trim().Length == 0) Error(o.Id, $"{pw}: нет модели");
                else if (knownModel != null && !knownModel(p.Model.Hash)) Warn(o.Id, $"{pw}: модели {p.Model} нет в игре");
                if (!Finite3(p.Pos)) Error(o.Id, $"{pw}: pos — три числа");
                if (!Finite3(p.Rot)) Error(o.Id, $"{pw}: rot — три числа");
                if (!string.IsNullOrEmpty(p.Id) && !propIds.Add(p.Id)) Warn(o.Id, $"{pw}: id {p.Id} повторяется");
            }
        }

        // Garage templates: slot numbers in messages count from 1, as the editor shows them.
        var garages = new Dictionary<string, GarageTemplate>();
        foreach (var g in doc.Garages ?? new())
        {
            string w = $"гараж {g.Id}";
            if (!IdOk(g.Id)) { Error(g.Id, "гараж: id — a-z, 0-9, _, - (до 32)"); continue; }
            if (!garages.TryAdd(g.Id, g)) { Error(g.Id, $"{w}: повторяется id"); continue; }
            if (string.IsNullOrWhiteSpace(g.Name)) Error(g.Id, $"{w}: нет названия");
            if (!Finite3(g.Spawn)) Error(g.Id, $"{w}: spawn — три числа");
            if (!Finite3(g.Exit)) Error(g.Id, $"{w}: exit — три числа");
            if (!double.IsFinite(g.Heading)) Error(g.Id, $"{w}: heading — число");
            if (Finite3(g.Spawn) && Finite3(g.Exit) && Dist(g.Spawn, g.Exit) > 25)
                Warn(g.Id, $"{w}: выход далеко от точки появления");
            var slots = g.Slots ?? new();
            if (slots.Count == 0) Error(g.Id, $"{w}: нет ни одного места для машины");
            if (slots.Count > HousesDocument.MaxSlots) Error(g.Id, $"{w}: больше {HousesDocument.MaxSlots} мест");
            for (int j = 0; j < slots.Count; j++)
            {
                var s = slots[j];
                string sw = $"{w}, место {j + 1}";
                if (!Finite3(s.Pos)) Error(g.Id, $"{sw}: pos — три числа");
                if (!double.IsFinite(s.Heading)) Error(g.Id, $"{sw}: heading — число");
                if (Finite3(s.Pos) && Finite3(g.Spawn) && Dist(s.Pos, g.Spawn) > 40)
                    Warn(g.Id, $"{sw}: дальше 40 м от точки появления");
            }
            for (int a = 0; a < slots.Count; a++)
                for (int b = a + 1; b < slots.Count; b++)
                    if (Finite3(slots[a].Pos) && Finite3(slots[b].Pos) && Dist2(slots[a].Pos, slots[b].Pos) < 2.5)
                        Warn(g.Id, $"{w}: места {a + 1} и {b + 1} ближе 2,5 м");
        }

        var classes = new HashSet<string>();
        var classGarage = new Dictionary<string, string>();
        var usedInteriors = new HashSet<string>();
        var usedGarages = new HashSet<string>();
        foreach (var c in doc.Classes ?? new())
        {
            string w = $"класс {c.Id}";
            if (!IdOk(c.Id)) { Error(c.Id, "класс: id — a-z, 0-9, _, - (до 32)"); continue; }
            if (!classes.Add(c.Id)) { Error(c.Id, $"{w}: повторяется id"); continue; }
            if (string.IsNullOrWhiteSpace(c.Name)) Error(c.Id, $"{w}: нет названия");
            if (c.Garage < 0 || c.Garage > HousesDocument.MaxGarage) Error(c.Id, $"{w}: garage — целое 0-{HousesDocument.MaxGarage}");
            if (c.Interior == null || !interiors.Contains(c.Interior)) Error(c.Id, $"{w}: нет интерьера {c.Interior}");
            else usedInteriors.Add(c.Interior);
            if (c.GarageInterior != null)
            {
                if (!garages.TryGetValue(c.GarageInterior, out var cg)) Error(c.Id, $"{w}: нет гаража {c.GarageInterior}");
                else
                {
                    usedGarages.Add(c.GarageInterior);
                    classGarage[c.Id] = c.GarageInterior;
                    int m = Math.Min(cg.Slots?.Count ?? 0, HousesDocument.MaxSlots);
                    if (m > 0 && m < c.Garage) Warn(c.Id, $"{w}: в гараже {c.GarageInterior} мест {m}, меньше чем {c.Garage} — вместимость {m}");
                }
            }
        }

        var ids = new HashSet<int>();
        var doors = new List<(int Id, double[] Door)>();
        foreach (var h in doc.Houses ?? new())
        {
            string sid = h.Id.ToString();
            string w = $"дом {h.Id}";
            if (h.Id <= 0) { Error(sid, "дом: id — целое больше нуля"); continue; }
            if (!ids.Add(h.Id)) { Error(sid, $"{w}: повторяется id"); continue; }
            if (string.IsNullOrWhiteSpace(h.Name)) Error(sid, $"{w}: нет названия");
            if (h.Cls == null || !classes.Contains(h.Cls)) Error(sid, $"{w}: нет класса {h.Cls}");
            if (h.Price <= 0) Error(sid, $"{w}: price — целое больше нуля");
            if (!Finite3(h.Door)) Error(sid, $"{w}: door — три числа");
            if (!double.IsFinite(h.Heading)) Error(sid, $"{w}: heading — число");
            if (h.Interior != null)
            {
                if (!interiors.Contains(h.Interior)) Error(sid, $"{w}: нет интерьера {h.Interior}");
                else usedInteriors.Add(h.Interior);
            }
            string resolved = null;   // the garage template the house gets: its own, else the class's
            if (h.GarageInterior != null)
            {
                if (!garages.ContainsKey(h.GarageInterior)) Error(sid, $"{w}: нет гаража {h.GarageInterior}");
                else { usedGarages.Add(h.GarageInterior); resolved = h.GarageInterior; }
            }
            else if (h.Cls != null && classGarage.TryGetValue(h.Cls, out var cgid)) resolved = cgid;
            if (h.GaragePoint != null)
            {
                var gp = h.GaragePoint;
                if (!Finite3(gp.Pos)) Error(sid, $"{w}: garagePoint — три числа");
                else
                {
                    if (gp.Pos[2] < -50) Warn(sid, $"{w}: въезд в гараж ниже z = -50 (под картой?)");
                    if (Finite3(h.Door) && Dist(gp.Pos, h.Door) > 60) Warn(sid, $"{w}: въезд в гараж дальше 60 м от двери");
                }
                if (!double.IsFinite(gp.Heading)) Error(sid, $"{w}: garagePoint heading — число");
            }
            else if (resolved != null) Warn(sid, $"{w}: нет метки въезда в гараж — машины заезжают у двери");
            if (Finite3(h.Door))
            {
                if (h.Door[2] < -50) Warn(sid, $"{w}: дверь ниже z = -50 (под картой?)");
                doors.Add((h.Id, h.Door));
            }
        }
        for (int i = 0; i < doors.Count; i++)
            for (int j = i + 1; j < doors.Count; j++)
                if (Dist(doors[i].Door, doors[j].Door) < 2)
                    Warn(doors[i].Id.ToString(), $"дом {doors[i].Id}: дверь ближе 2 м к двери дома {doors[j].Id}");

        foreach (string id in interiors.Where(i => !usedInteriors.Contains(i)))
            Warn(id, $"интерьер {id}: не используется ни классом, ни домом");
        foreach (string id in garages.Keys.Where(i => !usedGarages.Contains(i)))
            Warn(id, $"гараж {id}: не используется ни классом, ни домом");
        return issues;
    }

    public static bool HasErrors(IEnumerable<MapIssue> issues) => issues.Any(i => i.Severity == Severity.Error);

    private static bool IdOk(string id) => id != null && IdRe.IsMatch(id);

    private static bool Finite3(double[] v) => v != null && v.Length == 3 && v.All(double.IsFinite);

    // Distance on the ground (slot centres).
    private static double Dist2(double[] a, double[] b) =>
        Math.Sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));

    private static double Dist(double[] a, double[] b) =>
        Math.Sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
}
