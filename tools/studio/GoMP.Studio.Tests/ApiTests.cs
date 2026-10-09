using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace GoMP.Studio.Tests;

// The API on a temporary server-files folder, without game files.
public sealed class ApiTests : IDisposable
{
    private readonly string serverFiles = Path.Combine(Path.GetTempPath(), "gomp-studio-api-" + Guid.NewGuid().ToString("N"));
    private readonly WebApplicationFactory<Program> factory;
    private readonly HttpClient http;

    public ApiTests()
    {
        Directory.CreateDirectory(serverFiles);
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Studio:ServerFiles", serverFiles);
            b.UseSetting("Studio:Addons", Path.Combine(serverFiles, "addons"));
            b.UseSetting("Studio:Gta", "");
            b.UseSetting("Studio:NoBrowser", "1");
        });
        http = factory.CreateClient();
    }

    public void Dispose()
    {
        http.Dispose();
        factory.Dispose();
        Directory.Delete(serverFiles, true);
    }

    private const string Bench = """
        { "format": "gomp-map", "version": 1, "name": "Площадь",
          "objects": [ { "id": "a", "model": "prop_bench_01a", "pos": [215.1, -810.3, 30.7], "rot": [0, 0, 90] } ] }
        """;

    private Task<HttpResponseMessage> Put(string name, string json) =>
        http.PutAsync("/api/maps/" + Uri.EscapeDataString(name), new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

    [Fact]
    public async Task Status_tells_the_folders_and_that_there_is_no_game()
    {
        var s = await http.GetFromJsonAsync<JsonElement>("/api/status");
        Assert.Equal(Path.Combine(serverFiles, "maps"), s.GetProperty("maps").GetString());
        Assert.Equal("none", s.GetProperty("gta").GetProperty("state").GetString());
        var catalog = await http.GetAsync("/api/catalog?q=bench");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, catalog.StatusCode);
    }

    // The pages are built into the program (one file to copy), without the tests.
    [Fact]
    public async Task The_pages_are_built_in()
    {
        var index = await http.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, index.StatusCode);
        Assert.Contains("GoMP Studio", await index.Content.ReadAsStringAsync());
        Assert.Equal("no-cache", index.Headers.CacheControl?.ToString());
        foreach (string path in new[] { "/js/app.js", "/js/ui/vehicles.js", "/vendor/three/three.module.js", "/vendor/three/addons/loaders/GLTFLoader.js", "/css/studio.css" })
        {
            var r = await http.GetAsync(path);
            Assert.True(r.StatusCode == HttpStatusCode.OK, path);
            Assert.True(r.Content.Headers.ContentLength > 0, path);
        }
        Assert.Contains("javascript", (await http.GetAsync("/js/app.js")).Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/test/lod.test.mjs")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/nope.js")).StatusCode);
    }

    [Fact]
    public async Task Maps_are_saved_where_the_server_reads_them()
    {
        Assert.Equal("[]", await http.GetStringAsync("/api/maps"));
        var put = await Put("square", Bench);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        string file = Path.Combine(serverFiles, "maps", "square.json");
        Assert.True(File.Exists(file));
        Assert.Contains("\"prop_bench_01a\"", File.ReadAllText(file));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file), "*.tmp"));

        var list = await http.GetFromJsonAsync<JsonElement>("/api/maps");
        Assert.Equal("square", list[0].GetProperty("name").GetString());
        Assert.Equal(1, list[0].GetProperty("objects").GetInt32());
        var doc = await http.GetFromJsonAsync<JsonElement>("/api/maps/square");
        Assert.Equal(90, doc.GetProperty("objects")[0].GetProperty("rot")[2].GetDouble());
    }

    [Fact]
    public async Task A_map_with_errors_is_not_saved()
    {
        var put = await Put("bad", """{ "objects": [ { "id": "a", "model": "x", "pos": [0, 0, 0] }, { "id": "a", "model": "y", "pos": [0, 0, 0] } ] }""");
        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var body = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("повторяется", body.GetProperty("issues")[0].GetProperty("message").GetString());
        Assert.False(File.Exists(Path.Combine(serverFiles, "maps", "bad.json")));
        Assert.Equal(HttpStatusCode.BadRequest, (await Put("bad", "not json")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Put("a b", Bench)).StatusCode);
    }

    [Fact]
    public async Task Rename_and_delete()
    {
        await Put("one", Bench);
        await Put("two", Bench);
        Assert.Equal(HttpStatusCode.Conflict, (await http.PostAsync("/api/maps/one/rename?to=two", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.PostAsync("/api/maps/one/rename?to=three", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/api/maps/one")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await http.DeleteAsync("/api/maps/three")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.DeleteAsync("/api/maps/three")).StatusCode);
    }

    [Fact]
    public async Task The_cursor_from_the_game_reaches_the_browser()
    {
        Assert.Equal(HttpStatusCode.NoContent, (await http.GetAsync("/api/cursor")).StatusCode);
        using var events = await http.GetStreamAsync("/api/events");
        using var reader = new StreamReader(events);
        Assert.StartsWith(": connected", await reader.ReadLineAsync());
        File.WriteAllText(Path.Combine(serverFiles, "maps", ".cursor.json"), """{"x":100.5,"y":-200,"z":31,"heading":45,"dimension":0,"name":"Admin","at":1}""");

        var timeout = Task.Delay(5000);
        string line;
        do
        {
            var read = reader.ReadLineAsync();
            Assert.NotSame(timeout, await Task.WhenAny(read, timeout));
            line = await read;
        } while (line == null || !line.Contains("\"cursor\""));
        var ev = JsonDocument.Parse(line["data: ".Length..]).RootElement;
        Assert.Equal(100.5, ev.GetProperty("data").GetProperty("x").GetDouble());
        var c = await http.GetFromJsonAsync<JsonElement>("/api/cursor");
        Assert.Equal(45, c.GetProperty("heading").GetDouble());
    }
}
