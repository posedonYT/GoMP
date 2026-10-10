// The client side of fastdl (core/internal/fastdl on the server, port+1): the
// client scripts of a server (client_packages, without game_resources) are
// brought into a cache folder before they run, like RAGE.MP's downloader.
//
//   gomp::fastdl::Downloader d;
//   d.start("127.0.0.1", 22006, cacheDir);   // a thread of its own
//   ... d.progress() every frame ...         // state, bytes, files
//   d.files()                                // the package paths once Done
//
// Only what changed is fetched: the cache keeps an index (path -> size, sha256)
// written by the downloader, so files are not hashed again; files the server no
// longer has are removed. Every download is checked against the server's hash.
#pragma once

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace gomp::fastdl {

// SHA-256 of a byte string, streaming.
class Sha256 {
public:
    Sha256();
    void update(const void* data, std::size_t n);
    std::string hex();  // finishes; the object is spent afterwards

private:
    void block(const uint8_t* p);
    uint32_t h_[8];
    uint8_t buf_[64];
    std::size_t len_ = 0;
    uint64_t total_ = 0;
};

std::string sha256Hex(std::string_view data);

struct FileEntry {
    std::string path;  // relative, with '/'
    int64_t size = 0;
    std::string sha256;
};

// The files of a manifest ({"files": [{path, size, sha256}]}), or nullopt. Paths
// that would leave the cache (absolute, "..") make the whole manifest invalid.
std::optional<std::vector<FileEntry>> parseManifest(std::string_view json, std::string* error = nullptr);

// What the cache already has (index file) and what must be fetched or removed.
using Index = std::map<std::string, FileEntry>;
Index loadIndex(const std::filesystem::path& dir);
bool saveIndex(const std::filesystem::path& dir, const Index& index);
struct Plan {
    std::vector<FileEntry> fetch;
    std::vector<std::string> remove;  // in the index, gone from the server
    int64_t bytes = 0;
};
Plan plan(const std::vector<FileEntry>& remote, const Index& index, const std::filesystem::path& dir);

// A plain HTTP/1.1 GET (fastdl has no TLS): the body goes to sink in pieces
// (return false to stop); Content-Length and chunked bodies are understood.
struct HttpResponse {
    int status = 0;
    std::map<std::string, std::string> headers;  // names in lower case
    std::string error;
    bool ok() const { return error.empty() && status == 200; }
};
HttpResponse httpGet(const std::string& host, uint16_t port, const std::string& path,
                     const std::function<bool(const char*, std::size_t)>& sink, int timeoutMs = 15000);
std::string urlPath(std::string_view relative);  // percent-encoded, '/' kept

class Downloader {
public:
    enum class State { Idle, Running, Done, Failed };
    struct Progress {
        State state = State::Idle;
        int64_t bytesDone = 0, bytesTotal = 0;
        int filesDone = 0, filesTotal = 0;
        std::string error;
    };

    ~Downloader();
    void start(std::string host, uint16_t port, std::filesystem::path dir);
    Progress progress() const;
    std::vector<std::string> files() const;  // every package file (once Done)
    const std::filesystem::path& dir() const { return dir_; }

private:
    void run();
    std::string host_;
    uint16_t port_ = 0;
    std::filesystem::path dir_;
    std::thread thread_;
    std::atomic<bool> stop_{false};
    mutable std::mutex mu_;
    Progress progress_;
    std::vector<std::string> files_;
};

}  // namespace gomp::fastdl
