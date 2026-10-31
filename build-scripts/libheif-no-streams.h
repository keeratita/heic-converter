/* libheif build shim (forced-include via -include; see build-wasm.sh).

 * Replaces std::(o|i)stringstream with a non-logging fake so libheif's
 * error-formatting sites stop pulling libc++ iostream+locale into the WASM.
 * The libc++ <sstream> include guard is pre-defined so the macros cannot
 * collide with the real declarations. Error codes, subcodes and control flow
 * survive; streamed detail text is empty — it was already untrusted input
 * (sanitizeDecoderDetail() strips control chars and clamps it).
 *
 * Fails closed: build-wasm.sh aborts when the link map shows libc++ iostream.
 */
#pragma once

#include <cstddef>
#include <string>

/* Neutralize libc++'s <sstream>: its entire body sits inside this guard. */
#define _LIBCPP_SSTREAM

namespace std {

class heic_fake_stream {
 public:
  heic_fake_stream() = default;
  template <class T>
  heic_fake_stream(const T&) {}

  template <class T>
  heic_fake_stream& operator<<(const T&) {
    return *this;
  }
  template <class T>
  heic_fake_stream& operator>>(T& v) {
    v = T();
    return *this;
  }

  operator bool() const { return true; }

  void clear() {}
  bool good() const { return true; }
  bool fail() const { return false; }
  bool eof() const { return true; }
  long tellg() const { return 0; }
  long tellp() const { return 0; }

  heic_fake_stream& str(const std::string&) { return *this; }
  std::string str() const { return std::string(); }
};

inline bool getline(heic_fake_stream&, std::string&, char = '\n') {
  return false;
}

}  // namespace std

#define stringstream heic_fake_stream
#define ostringstream heic_fake_stream
#define istringstream heic_fake_stream
