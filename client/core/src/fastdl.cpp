#include "gomp/fastdl.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>

#include "gomp/json.hpp"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
using socket_t = SOCKET;
static const socket_t kInvalidSocket = INVALID_SOCKET;
static void closeSocket(socket_t s) { closesocket(s); }
#else
#include <netdb.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
using socket_t = int;
static const socket_t kInvalidSocket = -1;
static void closeSocket(socket_t s) { close(s); }
#endif

namespace gomp::fastdl {

namespace fs = std::filesystem;

// ------------------------------------------------------------------ SHA-256

namespace {
constexpr uint32_t kK[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
}  // namespace

Sha256::Sha256() : h_{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19} {}

void Sha256::block(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) | (uint32_t(p[i * 4 + 2]) << 8) | p[i * 4 + 3];
    for (int i = 16; i < 64; ++i) {
        const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
    for (int i = 0; i < 64; ++i) {
        const uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + kK[i] + w[i];
        const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    h_[0] += a, h_[1] += b, h_[2] += c, h_[3] += d, h_[4] += e, h_[5] += f, h_[6] += g, h_[7] += h;
}

void Sha256::update(const void* data, std::size_t n) {
    auto p = static_cast<const uint8_t*>(data);
    total_ += n;
    while (n) {
        const std::size_t take = std::min(n, sizeof(buf_) - len_);
        std::memcpy(buf_ + len_, p, take);
        len_ += take;
        p += take;
        n -= take;
        if (len_ == 64) {
            block(buf_);
            len_ = 0;
        }
    }
}

std::string Sha256::hex() {
    const uint64_t bits = total_ * 8;
    const uint8_t one = 0x80, zero = 0;
    update(&one, 1);
    while (len_ != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; ++i) len[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
    update(len, 8);
    std::string out;
    char b[9];
    for (uint32_t v : h_) {
        std::snprintf(b, sizeof(b), "%08x", v);
        out += b;
    }
    return out;
}

std::string sha256Hex(std::string_view data) {
    Sha256 h;
    h.update(data.data(), data.size());
    return h.hex();
}

// ------------------------------------------------------------------ manifest and index

namespace {
bool safePath(const std::string& p) {
    if (p.empty() || p[0] == '/' || p[0] == '\\' || p.find(':') != std::string::npos) return false;
    std::size_t start = 0;
    while (start <= p.size()) {
        const std::size_t end = p.find_first_of("/\\", start);
        const std::string part = p.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (part == ".." || part.empty()) return false;
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return true;
}

fs::path localPath(const fs::path& dir, const std::string& rel) {
    return dir / fs::path(std::u8string(reinterpret_cast<const char8_t*>(rel.data()), rel.size()));
}

constexpr const char* kIndexName = ".gomp-index.json";
}  // namespace

std::optional<std::vector<FileEntry>> parseManifest(std::string_view text, std::string* error) {
    auto v = json::parse(text, error);
    const Value* files = v ? v->get("files") : nullptr;
    if (!files || files->kind != Value::Kind::Array) {
        if (error && error->empty()) *error = "no files list";
        return std::nullopt;
    }
    std::vector<FileEntry> out;
    for (const Value& f : files->arr) {
        const Value* p = f.get("path");
        const Value* s = f.get("size");
        const Value* h = f.get("sha256");
        if (!p || p->kind != Value::Kind::String || !s || !h || h->kind != Value::Kind::String || !safePath(p->s)) {
            if (error) *error = "bad entry " + (p ? p->s : std::string("?"));
            return std::nullopt;
        }
        out.push_back({p->s, s->asInt(), h->s});
    }
    return out;
}

Index loadIndex(const fs::path& dir) {
    Index index;
    std::ifstream in(dir / kIndexName, std::ios::binary);
    if (!in) return index;
    const std::string text((std::istreambuf_iterator<char>(in)), {});
    if (auto files = parseManifest(text))
        for (auto& f : *files) index[f.path] = f;
    return index;
}

bool saveIndex(const fs::path& dir, const Index& index) {
    Value files;
    files.kind = Value::Kind::Array;
    for (const auto& [p, f] : index) {
        Value e;
        e.kind = Value::Kind::Map;
        e.map.emplace_back("path", Value::string(f.path));
        e.map.emplace_back("size", Value::integer(f.size));
        e.map.emplace_back("sha256", Value::string(f.sha256));
        files.arr.push_back(std::move(e));
    }
    Value root;
    root.kind = Value::Kind::Map;
    root.map.emplace_back("files", std::move(files));
    std::ofstream out(dir / kIndexName, std::ios::binary | std::ios::trunc);
    out << json::write(root);
    return static_cast<bool>(out);
}

Plan plan(const std::vector<FileEntry>& remote, const Index& index, const fs::path& dir) {
    Plan p;
    std::map<std::string, bool> wanted;
    for (const FileEntry& f : remote) {
        wanted[f.path] = true;
        auto it = index.find(f.path);
        std::error_code ec;
        const fs::path local = localPath(dir, f.path);
        const bool have = it != index.end() && it->second.sha256 == f.sha256 && fs::is_regular_file(local, ec) &&
                          static_cast<int64_t>(fs::file_size(local, ec)) == f.size;
        if (!have) {
            p.fetch.push_back(f);
            p.bytes += f.size;
        }
    }
    for (const auto& [path, f] : index)
        if (!wanted.count(path)) p.remove.push_back(path);
    return p;
}

// ------------------------------------------------------------------ HTTP

std::string urlPath(std::string_view rel) {
    static const char* hexd = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : rel) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hexd[c >> 4];
            out += hexd[c & 15];
        }
    }
    return out;
}

namespace {

struct Net {
#ifdef _WIN32
    Net() {
        WSADATA d;
        ok = WSAStartup(MAKEWORD(2, 2), &d) == 0;
    }
    ~Net() {
        if (ok) WSACleanup();
    }
    bool ok = false;
#else
    bool ok = true;
#endif
};

socket_t connectTo(const std::string& host, uint16_t port, int timeoutMs, std::string& err) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res) {
        err = "cannot resolve " + host;
        return kInvalidSocket;
    }
    socket_t s = kInvalidSocket;
    for (addrinfo* a = res; a; a = a->ai_next) {
        s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == kInvalidSocket) continue;
#ifdef _WIN32
        DWORD tv = static_cast<DWORD>(timeoutMs);
#else
        timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
#endif
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&tv), sizeof(tv));
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&tv), sizeof(tv));
        if (connect(s, a->ai_addr, static_cast<int>(a->ai_addrlen)) == 0) break;
        closeSocket(s);
        s = kInvalidSocket;
    }
    freeaddrinfo(res);
    if (s == kInvalidSocket) err = "cannot connect to " + host + ":" + std::to_string(port);
    return s;
}

}  // namespace

HttpResponse httpGet(const std::string& host, uint16_t port, const std::string& path,
                     const std::function<bool(const char*, std::size_t)>& sink, int timeoutMs) {
    HttpResponse r;
    Net net;
    if (!net.ok) {
        r.error = "no network";
        return r;
    }
    socket_t s = connectTo(host, port, timeoutMs, r.error);
    if (s == kInvalidSocket) return r;
    const std::string req = "GET " + path + " HTTP/1.1\r\nHost: " + host + ":" + std::to_string(port) +
                            "\r\nUser-Agent: GoMP\r\nConnection: close\r\n\r\n";
    if (send(s, req.data(), static_cast<int>(req.size()), 0) != static_cast<int>(req.size())) {
        closeSocket(s);
        r.error = "send failed";
        return r;
    }
    std::string buf;
    char tmp[64 << 10];
    auto more = [&]() {
        const int n = recv(s, tmp, sizeof(tmp), 0);
        if (n <= 0) return false;
        buf.append(tmp, static_cast<std::size_t>(n));
        return true;
    };
    // Status line and headers.
    std::size_t end;
    while ((end = buf.find("\r\n\r\n")) == std::string::npos) {
        if (buf.size() > (64 << 10) || !more()) {
            closeSocket(s);
            r.error = "no HTTP response";
            return r;
        }
    }
    const std::string head = buf.substr(0, end);
    buf.erase(0, end + 4);
    if (head.rfind("HTTP/1.", 0) != 0 || head.size() < 12) {
        closeSocket(s);
        r.error = "not HTTP";
        return r;
    }
    r.status = std::atoi(head.c_str() + 9);
    std::size_t pos = head.find("\r\n");
    while (pos != std::string::npos) {
        const std::size_t next = head.find("\r\n", pos + 2);
        const std::string line = head.substr(pos + 2, next == std::string::npos ? std::string::npos : next - pos - 2);
        const std::size_t colon = line.find(':');
        if (colon != std::string::npos) {
            std::string name = line.substr(0, colon);
            for (auto& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            std::string value = line.substr(colon + 1);
            while (!value.empty() && value.front() == ' ') value.erase(0, 1);
            r.headers[name] = value;
        }
        pos = next;
    }
    bool stopped = false;
    auto emit = [&](const char* d, std::size_t n) {
        if (!stopped && n && !sink(d, n)) stopped = true;
    };
    if (r.headers["transfer-encoding"].find("chunked") != std::string::npos) {
        for (;;) {
            std::size_t eol;
            while ((eol = buf.find("\r\n")) == std::string::npos)
                if (!more()) {
                    r.error = "chunked body cut short";
                    closeSocket(s);
                    return r;
                }
            const std::size_t size = std::strtoul(buf.substr(0, eol).c_str(), nullptr, 16);
            buf.erase(0, eol + 2);
            if (size == 0) break;
            while (buf.size() < size + 2)
                if (!more()) {
                    r.error = "chunked body cut short";
                    closeSocket(s);
                    return r;
                }
            emit(buf.data(), size);
            buf.erase(0, size + 2);
            if (stopped) break;
        }
    } else if (auto it = r.headers.find("content-length"); it != r.headers.end()) {
        int64_t left = std::strtoll(it->second.c_str(), nullptr, 10);
        for (;;) {
            const std::size_t take = static_cast<std::size_t>(std::min<int64_t>(left, static_cast<int64_t>(buf.size())));
            emit(buf.data(), take);
            buf.erase(0, take);
            left -= static_cast<int64_t>(take);
            if (left <= 0 || stopped) break;
            if (!more()) {
                r.error = "body cut short";
                break;
            }
        }
    } else {
        emit(buf.data(), buf.size());
        while (!stopped && more()) {
            emit(buf.data(), buf.size());
            buf.clear();
        }
    }
    closeSocket(s);
    return r;
}

// ------------------------------------------------------------------ downloader

Downloader::~Downloader() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
}

void Downloader::start(std::string host, uint16_t port, fs::path dir) {
    if (thread_.joinable()) {
        stop_ = true;
        thread_.join();
    }
    stop_ = false;
    host_ = std::move(host);
    port_ = port;
    dir_ = std::move(dir);
    {
        std::lock_guard lock(mu_);
        progress_ = Progress{};
        progress_.state = State::Running;
        files_.clear();
    }
    thread_ = std::thread([this] { run(); });
}

Downloader::Progress Downloader::progress() const {
    std::lock_guard lock(mu_);
    return progress_;
}

std::vector<std::string> Downloader::files() const {
    std::lock_guard lock(mu_);
    return files_;
}

void Downloader::run() {
    auto fail = [&](std::string why) {
        std::lock_guard lock(mu_);
        progress_.state = State::Failed;
        progress_.error = std::move(why);
    };
    std::string body;
    auto res = httpGet(host_, port_, "/manifest.json", [&](const char* d, std::size_t n) {
        body.append(d, n);
        return body.size() < (16u << 20);
    });
    if (!res.ok()) return fail(res.error.empty() ? "manifest: HTTP " + std::to_string(res.status) : "manifest: " + res.error);
    std::string err;
    auto remote = parseManifest(body, &err);
    if (!remote) return fail("manifest: " + err);
    std::error_code ec;
    fs::create_directories(dir_, ec);
    Index index = loadIndex(dir_);
    Plan p = plan(*remote, index, dir_);
    {
        std::lock_guard lock(mu_);
        progress_.bytesTotal = p.bytes;
        progress_.filesTotal = static_cast<int>(p.fetch.size());
    }
    for (const std::string& gone : p.remove) {
        fs::remove(localPath(dir_, gone), ec);
        index.erase(gone);
    }
    int64_t done = 0;
    for (const FileEntry& f : p.fetch) {
        if (stop_) return fail("stopped");
        const fs::path target = localPath(dir_, f.path);
        fs::create_directories(target.parent_path(), ec);
        fs::path tmp = target;
        tmp += ".part";
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) return fail("cannot write " + f.path);
        Sha256 hash;
        int64_t got = 0;
        auto r = httpGet(host_, port_, "/files/" + urlPath(f.path), [&](const char* d, std::size_t n) {
            out.write(d, static_cast<std::streamsize>(n));
            hash.update(d, n);
            got += static_cast<int64_t>(n);
            std::lock_guard lock(mu_);
            progress_.bytesDone = done + got;
            return !stop_.load();
        });
        out.close();
        if (!r.ok()) {
            fs::remove(tmp, ec);
            return fail(f.path + ": " + (r.error.empty() ? "HTTP " + std::to_string(r.status) : r.error));
        }
        if (got != f.size || hash.hex() != f.sha256) {
            fs::remove(tmp, ec);
            return fail(f.path + ": does not match the server's hash");
        }
        fs::remove(target, ec);
        fs::rename(tmp, target, ec);
        if (ec) return fail(f.path + ": " + ec.message());
        index[f.path] = f;
        done += f.size;
        std::lock_guard lock(mu_);
        progress_.filesDone++;
        progress_.bytesDone = done;
    }
    saveIndex(dir_, index);
    std::vector<std::string> all;
    for (const FileEntry& f : *remote) all.push_back(f.path);
    std::lock_guard lock(mu_);
    files_ = std::move(all);
    progress_.state = State::Done;
}

}  // namespace gomp::fastdl
