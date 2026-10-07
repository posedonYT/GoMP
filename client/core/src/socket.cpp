// Non-blocking UDP socket and secure random numbers for Windows and POSIX.
#include <cstring>

#include "gomp/transport.hpp"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")
using socket_t = SOCKET;
static const socket_t kInvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#if defined(__APPLE__)
#include <stdlib.h>
#else
#include <sys/random.h>
#endif
using socket_t = int;
static const socket_t kInvalidSocket = -1;
#endif

namespace gomp {

struct UdpSocket::Impl {
    socket_t fd = kInvalidSocket;
    sockaddr_storage server{};
    socklen_t serverLen = 0;
};

UdpSocket::UdpSocket() : impl_(std::make_unique<Impl>()) {}
UdpSocket::~UdpSocket() { close(); }

bool UdpSocket::open(const std::string& host, uint16_t port, std::string& err) {
#ifdef _WIN32
    static bool wsaReady = [] {
        WSADATA d;
        return WSAStartup(MAKEWORD(2, 2), &d) == 0;
    }();
    if (!wsaReady) {
        err = "WSAStartup failed";
        return false;
    }
#endif
    close();
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_protocol = IPPROTO_UDP;
    addrinfo* res = nullptr;
    std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
        err = "cannot resolve " + host;
        return false;
    }
    socket_t fd = ::socket(res->ai_family, SOCK_DGRAM, IPPROTO_UDP);
    if (fd == kInvalidSocket) {
        freeaddrinfo(res);
        err = "cannot create socket";
        return false;
    }
    std::memcpy(&impl_->server, res->ai_addr, res->ai_addrlen);
    impl_->serverLen = static_cast<socklen_t>(res->ai_addrlen);
    freeaddrinfo(res);
    int bufSize = 1 << 20;
    setsockopt(fd, SOL_SOCKET, SO_RCVBUF, reinterpret_cast<const char*>(&bufSize), sizeof(bufSize));
#ifdef _WIN32
    u_long nonBlocking = 1;
    ioctlsocket(fd, FIONBIO, &nonBlocking);
#else
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
#endif
    impl_->fd = fd;
    return true;
}

bool UdpSocket::send(const uint8_t* data, std::size_t n) {
    if (impl_->fd == kInvalidSocket) return false;
    auto r = ::sendto(impl_->fd, reinterpret_cast<const char*>(data), static_cast<int>(n), 0,
                      reinterpret_cast<const sockaddr*>(&impl_->server), impl_->serverLen);
    return r == static_cast<decltype(r)>(n);
}

int UdpSocket::recv(uint8_t* buf, std::size_t cap) {
    if (impl_->fd == kInvalidSocket) return -1;
    for (;;) {
        sockaddr_storage from{};
        socklen_t fromLen = sizeof(from);
        auto r = ::recvfrom(impl_->fd, reinterpret_cast<char*>(buf), static_cast<int>(cap), 0,
                            reinterpret_cast<sockaddr*>(&from), &fromLen);
        if (r < 0) {
#ifdef _WIN32
            int e = WSAGetLastError();
            if (e == WSAEWOULDBLOCK) return 0;
            if (e == WSAECONNRESET) continue;  // ICMP port unreachable from a previous send
#else
            if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
            if (errno == EINTR || errno == ECONNREFUSED) continue;
#endif
            return -1;
        }
        // Only accept datagrams from the server address.
        if (fromLen != impl_->serverLen || std::memcmp(&from, &impl_->server, fromLen) != 0) {
            const auto* a = reinterpret_cast<const sockaddr*>(&from);
            const auto* b = reinterpret_cast<const sockaddr*>(&impl_->server);
            bool same = false;
            if (a->sa_family == AF_INET && b->sa_family == AF_INET) {
                const auto* x = reinterpret_cast<const sockaddr_in*>(a);
                const auto* y = reinterpret_cast<const sockaddr_in*>(b);
                same = x->sin_port == y->sin_port && x->sin_addr.s_addr == y->sin_addr.s_addr;
            }
            if (!same) continue;
        }
        return static_cast<int>(r);
    }
}

void UdpSocket::close() {
    if (impl_ && impl_->fd != kInvalidSocket) {
#ifdef _WIN32
        closesocket(impl_->fd);
#else
        ::close(impl_->fd);
#endif
        impl_->fd = kInvalidSocket;
    }
}

void randomBytes(uint8_t* buf, std::size_t n) {
#ifdef _WIN32
    BCryptGenRandom(nullptr, buf, static_cast<ULONG>(n), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
#elif defined(__APPLE__)
    arc4random_buf(buf, n);
#else
    while (n > 0) {
        ssize_t r = getrandom(buf, n, 0);
        if (r <= 0) continue;
        buf += r;
        n -= static_cast<std::size_t>(r);
    }
#endif
}

}  // namespace gomp
