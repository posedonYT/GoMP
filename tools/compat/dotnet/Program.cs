// gomp-compat: the C# side of GoMP's RAGE.MP compatibility tools.
//
//   gomp-compat api   <assembly.dll> [--json out.json]
//       the public API of the RAGE server assembly (Bootstrapper.dll: namespaces
//       GTANetworkAPI, GTANetworkMethods...): types and members as Type.Member/arity
//   gomp-compat scan  <folder> --api <Bootstrapper.dll> [--impl <GoMP facade.dll>] [--json out.json]
//       what the mod in folder uses of that API: from its assemblies (member
//       references, exact) and its .cs sources (NAPI.X.Y calls, attributes, by text);
//       with --impl, what GoMP's facade lacks of it
//   gomp-compat cover <api.dll> <impl.dll>
//       how much of the API the facade has
//
// Assemblies are read with System.Reflection.Metadata: nothing is loaded or run.
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GoMP.Compat;

public static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"gomp-compat: {e.Message}");
            return 1;
        }
    }

    private static string Opt(string[] args, string name) =>
        Array.IndexOf(args, name) is int i and >= 0 && i + 1 < args.Length ? args[i + 1] : null;

    private static int Run(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: gomp-compat api <dll> | scan <folder> --api <dll> [--impl <dll>] | cover <api.dll> <impl.dll>");
            return 2;
        }
        var json = Opt(args, "--json");
        switch (args[0])
        {
            case "api":
            {
                var api = ApiModel.Read(args[1]);
                if (json != null) File.WriteAllText(json, JsonSerializer.Serialize(api.Types, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine($"{args[1]}: {api.Types.Count} types, {api.Members.Count} members");
                return 0;
            }
            case "scan":
            {
                var apiPath = Opt(args, "--api") ?? throw new ArgumentException("scan needs --api <Bootstrapper.dll>");
                var api = ApiModel.Read(apiPath);
                var impl = Opt(args, "--impl") is string ip ? ApiModel.Read(ip) : null;
                var report = Scanner.Scan(args[1], api, impl);
                if (json != null) File.WriteAllText(json, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine($"{args[1]}: {report.Files} files, {report.Rows.Count} API names used" + (impl != null ? $", {report.Rows.Count(r => !r.Have)} missing in GoMP" : ""));
                foreach (var r in report.Rows) Console.WriteLine($"{(impl == null ? "  " : r.Have ? "  ok " : "  -- ")} {r.Api,-60} x{r.Count}");
                return 0;
            }
            case "cover":
            {
                var api = ApiModel.Read(args[1]);
                var impl = ApiModel.Read(args[2]);
                var have = api.Members.Count(m => impl.Members.Contains(m));
                Console.WriteLine($"{have} / {api.Members.Count} members ({100.0 * have / Math.Max(1, api.Members.Count):F1}%)");
                return 0;
            }
            default:
                Console.Error.WriteLine($"unknown command {args[0]}");
                return 2;
        }
    }
}

// The public surface of an assembly in the GTANetwork* namespaces.
public sealed class ApiModel
{
    public const string Prefix = "GTANetwork";
    public Dictionary<string, List<string>> Types { get; } = new();  // type -> members
    public HashSet<string> Members { get; } = new();                 // "Type.Member/arity"

    public static ApiModel Read(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        var model = new ApiModel();
        foreach (var th in md.TypeDefinitions)
        {
            var t = md.GetTypeDefinition(th);
            var name = TypeName(md, th);
            if (name == null || !name.StartsWith(Prefix, StringComparison.Ordinal) || !IsPublic(t.Attributes)) continue;
            var members = new List<string>();
            foreach (var mh in t.GetMethods())
            {
                var m = md.GetMethodDefinition(mh);
                if ((m.Attributes & System.Reflection.MethodAttributes.MemberAccessMask) != System.Reflection.MethodAttributes.Public) continue;
                var mname = md.GetString(m.Name);
                int arity = m.GetParameters().Select(md.GetParameter).Count(p => p.SequenceNumber > 0);
                members.Add($"{mname}/{arity}");
            }
            foreach (var fh in t.GetFields())
            {
                var f = md.GetFieldDefinition(fh);
                if ((f.Attributes & System.Reflection.FieldAttributes.FieldAccessMask) == System.Reflection.FieldAttributes.Public)
                    members.Add($"{md.GetString(f.Name)}/f");
            }
            members = members.Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
            model.Types[name] = members;
            foreach (var m in members) model.Members.Add($"{name}.{m}");
        }
        return model;
    }

    private static bool IsPublic(System.Reflection.TypeAttributes a)
    {
        var v = a & System.Reflection.TypeAttributes.VisibilityMask;
        return v == System.Reflection.TypeAttributes.Public || v == System.Reflection.TypeAttributes.NestedPublic;
    }

    // Namespace.Outer+Inner, or null for the <Module> pseudo type.
    public static string TypeName(MetadataReader md, TypeDefinitionHandle h)
    {
        var t = md.GetTypeDefinition(h);
        var name = md.GetString(t.Name);
        if (name == "<Module>") return null;
        var declaring = t.GetDeclaringType();
        if (!declaring.IsNil) return $"{TypeName(md, declaring)}+{name}";
        var ns = md.GetString(t.Namespace);
        return ns.Length == 0 ? name : $"{ns}.{name}";
    }
}

public sealed record Row(string Api, int Count, bool Have);
public sealed record Report(string Folder, int Files, List<Row> Rows);

public static class Scanner
{
    private static readonly Regex NapiCall = new(@"\bNAPI\.(\w+)\.(\w+)\s*\(", RegexOptions.Compiled);
    private static readonly Regex Attribute = new(@"\[(ServerEvent|RemoteEvent|RemoteProc|Command)\b", RegexOptions.Compiled);
    private static readonly Regex ServerEvent = new(@"ServerEvent\s*\(\s*Event\.(\w+)", RegexOptions.Compiled);
    private static readonly Regex MemberAccess = new(@"\.([A-Z]\w+)\b", RegexOptions.Compiled);
    // The entity types whose members a script reaches through its variables (player.Position...).
    private static readonly string[] EntityTypes = { "Entity", "Player", "Vehicle", "Object", "Ped", "Blip", "Marker", "Checkpoint", "ColShape", "TextLabel", "DummyEntity" };

    public static Report Scan(string folder, ApiModel api, ApiModel impl)
    {
        var used = new Dictionary<string, int>(StringComparer.Ordinal);
        void Add(string key)
        {
            used[key] = used.GetValueOrDefault(key) + 1;
        }
        int files = 0;
        // Member names of the entity types (by name: a script's variables have no types in a text scan).
        var entityMembers = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var t in EntityTypes)
            if (api.Types.TryGetValue("GTANetworkAPI." + t, out var ms))
                foreach (var m in ms)
                {
                    var n = m[..m.IndexOf('/')];
                    if (n.StartsWith("get_", StringComparison.Ordinal) || n.StartsWith("set_", StringComparison.Ordinal)) n = n[4..];
                    else if (n.StartsWith("op_", StringComparison.Ordinal) || n == ".ctor") continue;
                    entityMembers.TryAdd(n, t);
                }
        foreach (var path in Directory.EnumerateFiles(folder, "*.*", SearchOption.AllDirectories))
        {
            if (path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") || path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")) continue;
            if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            {
                if (!ReferencesApi(path, out var refs)) continue;
                files++;
                foreach (var r in refs) Add(r);
            }
            else if (path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                files++;
                var text = File.ReadAllText(path);
                foreach (Match m in NapiCall.Matches(text)) Add($"NAPI.{m.Groups[1].Value}.{m.Groups[2].Value}");
                foreach (Match m in ServerEvent.Matches(text)) Add($"Event.{m.Groups[1].Value}");
                foreach (Match m in Attribute.Matches(text)) Add($"[{m.Groups[1].Value}]");
                foreach (Match m in MemberAccess.Matches(text))
                    if (entityMembers.TryGetValue(m.Groups[1].Value, out var owner)) Add($"{owner}.{m.Groups[1].Value}");
            }
        }
        var rows = used.Select(kv => new Row(kv.Key, kv.Value, impl != null && Has(impl, kv.Key)))
            .OrderBy(r => r.Have).ThenByDescending(r => r.Count).ThenBy(r => r.Api, StringComparer.Ordinal).ToList();
        return new Report(folder, files, rows);
    }

    // A name the scan found, against a model: a member reference (Type.Member/arity), NAPI.X.Y (any arity),
    // Event.X (an enum value of GTANetworkAPI.Event) or an attribute (a type of that name).
    public static bool Has(ApiModel model, string key)
    {
        if (key.StartsWith("NAPI.", StringComparison.Ordinal))
        {
            var parts = key.Split('.');
            // NAPI.Player is a static member of NAPI whose type (GTANetworkMethods.Player...) has the method.
            return model.Types.Any(t => t.Key.StartsWith("GTANetworkMethods.", StringComparison.Ordinal) && t.Key.EndsWith("." + parts[1], StringComparison.Ordinal) &&
                                        t.Value.Any(m => m.StartsWith(parts[2] + "/", StringComparison.Ordinal)));
        }
        if (key.StartsWith("Event.", StringComparison.Ordinal))
            return model.Types.TryGetValue("GTANetworkAPI.Event", out var ev) && ev.Contains(key["Event.".Length..] + "/f");
        if (key.StartsWith('['))
            return model.Types.Keys.Any(t => t.EndsWith("." + key.Trim('[', ']') + "Attribute", StringComparison.Ordinal));
        // Type.Name from a text scan: a method of any arity, or a property (get_/set_).
        if (!key.Contains('/') && key.Split('.') is { Length: 2 } tm && model.Types.TryGetValue("GTANetworkAPI." + tm[0], out var tms))
            return tms.Any(m => m.StartsWith(tm[1] + "/", StringComparison.Ordinal) || m.StartsWith("get_" + tm[1] + "/", StringComparison.Ordinal));
        return model.Members.Contains(key) || model.Types.ContainsKey(key);
    }

    // The GTANetwork* types and members an assembly references.
    private static bool ReferencesApi(string path, out List<string> refs)
    {
        refs = new List<string>();
        try
        {
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            if (!pe.HasMetadata) return false;
            var md = pe.GetMetadataReader();
            foreach (var mh in md.MemberReferences)
            {
                var m = md.GetMemberReference(mh);
                if (m.Parent.Kind != HandleKind.TypeReference) continue;
                var type = RefName(md, (TypeReferenceHandle)m.Parent);
                if (!type.StartsWith(ApiModel.Prefix, StringComparison.Ordinal)) continue;
                var name = md.GetString(m.Name);
                refs.Add($"{type}.{name}/{Arity(md, m)}");
            }
            return refs.Count > 0;
        }
        catch (BadImageFormatException)
        {
            return false;
        }
    }

    private static string Arity(MetadataReader md, MemberReference m)
    {
        var blob = md.GetBlobReader(m.Signature);
        var header = blob.ReadSignatureHeader();
        if (header.Kind == SignatureKind.Field) return "f";
        if (header.IsGeneric) blob.ReadCompressedInteger();
        return blob.ReadCompressedInteger().ToString();
    }

    private static string RefName(MetadataReader md, TypeReferenceHandle h)
    {
        var t = md.GetTypeReference(h);
        var name = md.GetString(t.Name);
        if (t.ResolutionScope.Kind == HandleKind.TypeReference) return $"{RefName(md, (TypeReferenceHandle)t.ResolutionScope)}+{name}";
        var ns = md.GetString(t.Namespace);
        return ns.Length == 0 ? name : $"{ns}.{name}";
    }
}
