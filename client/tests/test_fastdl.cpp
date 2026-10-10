// JSON, SHA-256 and the fastdl downloader (client/core: json.cpp, fastdl.cpp)
// against a small HTTP server in the test.
#include "doctest.h"

#include <atomic>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <thread>

#include "gomp/fastdl.hpp"
#include "gomp/json.hpp"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
using tsock = SOCKET;
#define TCLOSE closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using tsock = int;
#define TCLOSE close
#endif

using namespace gomp;
namespace fs = std::filesystem;

namespace {

// Serves path -> body; chunked paths are sent in chunks; counts the requests per path.
class TestServer {
public:
    std::map<std::string, std::string> routes;
    std::map<std::string, bool> chunked;
    std::map<std::string, int> hits;
    std::mutex mu;

    TestServer() {
#ifdef _WIN32
        WSADATA d;
        WSAStartup(MAKEWORD(2, 2), &d);
#endif
        fd_ = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof(a));
        socklen_t len = sizeof(a);
        getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &len);
        port = ntohs(a.sin_port);
        listen(fd_, 16);
        thread_ = std::thread([this] { loop(); });
    }
    ~TestServer() {
        stop_ = true;
        TCLOSE(fd_);
        thread_.join();
#ifdef _WIN32
        WSACleanup();
#endif
    }
    uint16_t port = 0;

private:
    void loop() {
        while (!stop_) {
            tsock c = accept(fd_, nullptr, nullptr);
#ifdef _WIN32
            if (c == INVALID_SOCKET) break;
#else
            if (c < 0) break;
#endif
            std::string req;
            char buf[4096];
            while (req.find("\r\n\r\n") == std::string::npos) {
                int n = recv(c, buf, sizeof(buf), 0);
                if (n <= 0) break;
                req.append(buf, n);
            }
            std::string path = req.substr(4, req.find(' ', 4) - 4);
            std::string body, head;
            bool found, chunk;
            {
                std::lock_guard lock(mu);
                hits[path]++;
                found = routes.count(path) > 0;
                body = found ? routes[path] : "";
                chunk = chunked[path];
            }
            if (!found) {
                head = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                send(c, head.data(), static_cast<int>(head.size()), 0);
            } else if (chunk) {
                head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
                send(c, head.data(), static_cast<int>(head.size()), 0);
                for (std::size_t i = 0; i < body.size(); i += 7) {
                    std::string part = body.substr(i, 7);
                    char sz[16];
                    std::snprintf(sz, sizeof(sz), "%zx\r\n", part.size());
                    std::string out = sz + part + "\r\n";
                    send(c, out.data(), static_cast<int>(out.size()), 0);
                }
                send(c, "0\r\n\r\n", 5, 0);
            } else {
                head = "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n";
                send(c, head.data(), static_cast<int>(head.size()), 0);
                send(c, body.data(), static_cast<int>(body.size()), 0);
            }
            TCLOSE(c);
        }
    }
    tsock fd_;
    std::thread thread_;
    std::atomic<bool> stop_{false};
};

std::string manifestOf(const std::map<std::string, std::string>& files) {
    std::string out = "{\"files\":[";
    bool first = true;
    for (const auto& [p, body] : files) {
        if (!first) out += ",";
        first = false;
        out += "{\"path\":\"" + p + "\",\"size\":" + std::to_string(body.size()) + ",\"sha256\":\"" + fastdl::sha256Hex(body) + "\"}";
    }
    return out + "]}";
}

void serve(TestServer& s, const std::map<std::string, std::string>& files) {
    std::lock_guard lock(s.mu);
    s.routes.clear();
    s.routes["/manifest.json"] = manifestOf(files);
    for (const auto& [p, body] : files) s.routes["/files/" + fastdl::urlPath(p)] = body;
}

fastdl::Downloader::Progress waitDone(fastdl::Downloader& d) {
    for (int i = 0; i < 500; ++i) {
        auto p = d.progress();
        if (p.state != fastdl::Downloader::State::Running) return p;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return d.progress();
}

std::string readFile(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(in)), {});
}

fs::path tempDir() {
    auto d = fs::temp_directory_path() / ("gomp-fastdl-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(d);
    return d;
}

}  // namespace

TEST_CASE("json: values, escapes, errors, and back") {
    auto v = json::parse(R"({"a": 1, "b": [true, false, null, -2.5e1], "s": "x\"y\\n\u00e9\ud83d\ude00", "o": {}})");
    REQUIRE(v);
    CHECK(v->get("a")->kind == Value::Kind::Int);
    CHECK(v->get("a")->i == 1);
    CHECK(v->get("b")->arr.size() == 4);
    CHECK(v->get("b")->arr[3].f == -25.0);
    CHECK(v->get("s")->s == "x\"y\\n\xC3\xA9\xF0\x9F\x98\x80");
    CHECK(v->map[0].first == "a");  // key order kept
    CHECK(json::write(*json::parse(R"({"k":[1,"t",true,null]})")) == R"({"k":[1,"t",true,null]})");
    std::string err;
    CHECK_FALSE(json::parse("{\"a\":}", &err));
    CHECK_FALSE(err.empty());
    CHECK_FALSE(json::parse("[1,2] x"));
    CHECK_FALSE(json::parse("\"unterminated"));
    CHECK(json::write(Value::string("a\nb\x01")) == "\"a\\nb\\u0001\"");
}

TEST_CASE("sha256: the standard vectors, streamed in pieces too") {
    CHECK(fastdl::sha256Hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(fastdl::sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const std::string long_ = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    CHECK(fastdl::sha256Hex(long_) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    fastdl::Sha256 h;
    for (char c : long_) h.update(&c, 1);
    CHECK(h.hex() == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST_CASE("manifest: entries, and paths that would leave the cache are refused") {
    auto m = fastdl::parseManifest(R"({"files":[{"path":"index.js","size":3,"sha256":"aa"},{"path":"ui/app.js","size":1,"sha256":"bb"}]})");
    REQUIRE(m);
    CHECK(m->size() == 2);
    CHECK((*m)[1].path == "ui/app.js");
    for (const char* bad : {"../evil.js", "/abs.js", "a/../../b", "C:/x.js", "a//b"}) {
        std::string text = std::string(R"({"files":[{"path":")") + bad + R"(","size":1,"sha256":"x"}]})";
        CHECK_FALSE(fastdl::parseManifest(text));
    }
    CHECK_FALSE(fastdl::parseManifest("{}"));
    CHECK(fastdl::urlPath("ui/my file+é.js") == "ui/my%20file%2B%C3%A9.js");
}

TEST_CASE("downloader: fetches what changed only, removes what the server dropped") {
    TestServer server;
    const fs::path dir = tempDir();
    std::map<std::string, std::string> files = {
        {"index.js", "require('./ui/app.js');"},
        {"ui/app.js", std::string(100000, 'x')},
        {"ui/page.html", "<h1>hi</h1>"},
    };
    serve(server, files);
    {
        std::lock_guard lock(server.mu);
        server.chunked["/files/ui/page.html"] = true;  // a chunked body
    }
    fastdl::Downloader d;
    d.start("127.0.0.1", server.port, dir);
    auto p = waitDone(d);
    REQUIRE_MESSAGE(p.state == fastdl::Downloader::State::Done, p.error);
    CHECK(p.filesDone == 3);
    CHECK(p.bytesDone == p.bytesTotal);
    CHECK(readFile(dir / "ui" / "app.js") == files["ui/app.js"]);
    CHECK(readFile(dir / "ui" / "page.html") == "<h1>hi</h1>");
    CHECK(d.files().size() == 3);

    // Again: nothing is downloaded.
    fastdl::Downloader again;
    again.start("127.0.0.1", server.port, dir);
    p = waitDone(again);
    CHECK(p.state == fastdl::Downloader::State::Done);
    CHECK(p.filesTotal == 0);
    CHECK(server.hits["/files/ui/app.js"] == 1);

    // One file changed, one removed on the server.
    files["index.js"] = "require('./ui/new.js');";
    files.erase("ui/page.html");
    serve(server, files);
    fastdl::Downloader third;
    third.start("127.0.0.1", server.port, dir);
    p = waitDone(third);
    CHECK(p.state == fastdl::Downloader::State::Done);
    CHECK(p.filesTotal == 1);
    CHECK(readFile(dir / "index.js") == files["index.js"]);
    CHECK_FALSE(fs::exists(dir / "ui" / "page.html"));
    CHECK(server.hits["/files/ui/app.js"] == 1);
    fs::remove_all(dir);
}

TEST_CASE("downloader: a file that does not match the server's hash fails and is not kept") {
    TestServer server;
    const fs::path dir = tempDir();
    {
        std::lock_guard lock(server.mu);
        server.routes["/manifest.json"] = R"({"files":[{"path":"a.js","size":5,"sha256":")" + fastdl::sha256Hex("hello") + R"("}]})";
        server.routes["/files/a.js"] = "HELLO";
    }
    fastdl::Downloader d;
    d.start("127.0.0.1", server.port, dir);
    auto p = waitDone(d);
    CHECK(p.state == fastdl::Downloader::State::Failed);
    CHECK(p.error.find("hash") != std::string::npos);
    CHECK_FALSE(fs::exists(dir / "a.js"));
    CHECK_FALSE(fs::exists(dir / "a.js.part"));
    // No server at all: a clear failure, not a hang.
    fastdl::Downloader none;
    none.start("127.0.0.1", 1, dir);
    CHECK(waitDone(none).state == fastdl::Downloader::State::Failed);
    fs::remove_all(dir);
}
