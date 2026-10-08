// What maps.js would refuse (errors) and what looks wrong (warnings).
namespace GoMP.Studio.Maps;

public enum Severity { Error, Warning }

public sealed record MapIssue(Severity Severity, string ObjectId, string Message);

public static class MapValidator
{
    // knownModel: whether the game has the model (null: not checked).
    public static List<MapIssue> Check(MapDocument doc, Func<uint, bool> knownModel = null)
    {
        var issues = new List<MapIssue>();
        void Error(string id, string m) => issues.Add(new MapIssue(Severity.Error, id, m));
        void Warn(string id, string m) => issues.Add(new MapIssue(Severity.Warning, id, m));

        if (doc.Format != MapDocument.FormatName) Error(null, $"формат {doc.Format}, нужен {MapDocument.FormatName}");
        if (doc.Version != MapDocument.CurrentVersion) Error(null, $"версия {doc.Version}, нужна {MapDocument.CurrentVersion}");
        if (doc.Objects.Count > MapDocument.MaxObjects) Error(null, $"объектов {doc.Objects.Count}, можно не больше {MapDocument.MaxObjects}");
        var ids = new HashSet<string>();
        foreach (var o in doc.Objects)
        {
            string id = o.Id;
            if (string.IsNullOrEmpty(id)) Error(null, "объект без id");
            else if (!ids.Add(id)) Error(id, "id повторяется");
            if (o.Model.IsEmpty) Error(id, "нет модели");
            if (!Finite3(o.Pos)) Error(id, "pos — три числа");
            if (!Finite3(o.Rot)) Error(id, "rot — три числа");
            if (o.Alpha < 0 || o.Alpha > 255) Error(id, "alpha от 0 до 255");
            if (Finite3(o.Pos))
            {
                // The map of GTA V lies within ±8000 m; far below the sea there is nothing.
                if (Math.Abs(o.Pos[0]) > 10000 || Math.Abs(o.Pos[1]) > 10000) Warn(id, "далеко за краем карты");
                if (o.Pos[2] < -200 || o.Pos[2] > 2700) Warn(id, "странная высота");
            }
            if (!o.Model.IsEmpty && knownModel != null && !knownModel(o.Model.Hash)) Warn(id, $"модели {o.Model} нет в игре");
        }
        return issues;
    }

    public static bool HasErrors(IEnumerable<MapIssue> issues) => issues.Any(i => i.Severity == Severity.Error);

    private static bool Finite3(double[] v) => v != null && v.Length == 3 && v.All(double.IsFinite);
}
