// Editing GTA V metadata XML (vehicles.meta, handling.meta, carvariations.meta,
// carcols.meta) without disturbing the rest of the file: whitespace is kept,
// a value is changed in place (<fMass value="..." />, <gameName>...</gameName>,
// <vecCentreOfMassOffset x=".." y=".." z=".." />), and lists are rewritten with
// the indentation they had.
using System.Globalization;
using System.Xml.Linq;

namespace GoMP.Studio.Vehicles;

public static class MetaXml
{
    public static XDocument Parse(string text) => XDocument.Parse(text, LoadOptions.PreserveWhitespace);

    public static string Write(XDocument doc)
    {
        var decl = doc.Declaration != null ? doc.Declaration + "\n" : "";
        return decl + doc.Root.ToString(SaveOptions.DisableFormatting) + "\n";
    }

    public static string F(float v) => v.ToString("0.######", CultureInfo.InvariantCulture);

    public static XElement Child(XElement e, string name) =>
        e.Elements().FirstOrDefault(c => string.Equals(c.Name.LocalName, name, StringComparison.OrdinalIgnoreCase));

    // <name value="1.5" /> or <name>text</name>.
    public static string Get(XElement item, string name)
    {
        var c = Child(item, name);
        if (c == null) return null;
        return c.Attribute("value")?.Value ?? (c.HasElements ? null : c.Value.Trim());
    }

    public static float? GetFloat(XElement item, string name) =>
        float.TryParse(Get(item, name), NumberStyles.Float, CultureInfo.InvariantCulture, out float f) ? f : null;

    public static float[] GetVec(XElement item, string name)
    {
        var c = Child(item, name);
        if (c == null) return null;
        float A(string a) => float.TryParse(c.Attribute(a)?.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out float f) ? f : 0;
        return new[] { A("x"), A("y"), A("z") };
    }

    // Sets a value; the element is added at the end (indented like its siblings) when it is missing.
    public static void Set(XElement item, string name, string value, bool asAttribute)
    {
        var c = Child(item, name) ?? AddChild(item, name);
        if (asAttribute)
        {
            c.RemoveNodes();
            c.SetAttributeValue("value", value);
        }
        else
        {
            c.SetAttributeValue("value", null);
            c.Value = value ?? "";
        }
    }

    public static void SetVec(XElement item, string name, float[] v)
    {
        var c = Child(item, name) ?? AddChild(item, name);
        c.SetAttributeValue("x", F(v[0]));
        c.SetAttributeValue("y", F(v[1]));
        c.SetAttributeValue("z", F(v[2]));
    }

    private static XElement AddChild(XElement item, string name)
    {
        string indent = IndentOf(item.Elements().LastOrDefault()) ?? IndentOf(item) + "  ";
        var c = new XElement(name);
        var last = item.Nodes().LastOrDefault();
        if (last is XText t && string.IsNullOrWhiteSpace(t.Value))
        {
            t.AddBeforeSelf(new XText("\n" + indent.TrimStart('\n')), c);
        }
        else
        {
            item.Add(new XText("\n" + indent), c, new XText("\n" + IndentOf(item)));
        }
        return c;
    }

    // The whitespace before an element on its line (its indentation).
    public static string IndentOf(XElement e)
    {
        if (e?.PreviousNode is XText t)
        {
            int nl = t.Value.LastIndexOf('\n');
            return nl >= 0 ? t.Value[(nl + 1)..] : t.Value;
        }
        return e == null ? null : "";
    }

    // Replaces the child elements of a list with new ones, one per line.
    public static void SetList(XElement list, IEnumerable<XElement> items)
    {
        string outer = IndentOf(list) ?? "";
        string inner = IndentOf(list.Elements().FirstOrDefault()) ?? outer + "  ";
        // Taken before the list is emptied: items may be made from its own elements.
        var all = items.ToList();
        list.RemoveNodes();
        foreach (var i in all) list.Add(new XText("\n" + inner), i);
        if (list.HasElements) list.Add(new XText("\n" + outer));
    }

    // Numbers of a <... content="char_array"> or float_array text.
    public static int[] Ints(string text) =>
        (text ?? "").Split((char[])null, StringSplitOptions.RemoveEmptyEntries)
            .Select(s => int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : 0).ToArray();

    public static string ArrayText(IEnumerable<string> values, string indent) =>
        string.Concat(values.Select(v => "\n" + indent + v)) + "\n" + (indent.Length >= 2 ? indent[..^2] : "");
}
