#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

toolchain=$(mktemp -d)
trap 'rm -rf "$toolchain"' EXIT

if command -v em++ >/dev/null; then
  export EM_CACHE="${EM_CACHE:-$PWD/backend/build/emscripten-cache}"
else
  emsdk_version=4.0.23
  git clone --depth 1 --branch "$emsdk_version" https://github.com/emscripten-core/emsdk.git "$toolchain/emsdk"
  "$toolchain/emsdk/emsdk" install "$emsdk_version"
  "$toolchain/emsdk/emsdk" activate "$emsdk_version"
  source "$toolchain/emsdk/emsdk_env.sh"
fi

boost_include=${BOOST_INCLUDE_DIR:-}
if [[ -z "$boost_include" ]] && command -v brew >/dev/null; then
  boost_include="$(brew --prefix boost)/include"
fi
if [[ ! -f "$boost_include/boost/json.hpp" ]]; then
  boost_version=1.89.0
  boost_archive="boost-$boost_version-b2-nodocs.tar.xz"
  boost_sha256=875cc413afa6b86922b6df3b2ad23dec4511c8a741753e57c1129e7fa753d700
  archive="$toolchain/$boost_archive"
  echo "Downloading Boost $boost_version headers"
  curl --fail --silent --show-error --location --retry 3 --output "$archive" \
    "https://github.com/boostorg/boost/releases/download/boost-$boost_version/$boost_archive"
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$boost_sha256" "$archive" | sha256sum --check
  else
    printf '%s  %s\n' "$boost_sha256" "$archive" | shasum -a 256 --check
  fi
  boost_include="$toolchain/boost"
  mkdir -p "$boost_include"
  tar -xJf "$archive" --strip-components=1 -C "$boost_include"
fi

mkdir -p frontend/node_modules/.cache/saarathi
em++ backend/server.cpp -std=c++17 -O2 -fexceptions -isystem "$boost_include" \
  --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
  -sEXPORTED_RUNTIME_METHODS=ccall -sALLOW_MEMORY_GROWTH=1 \
  -o frontend/node_modules/.cache/saarathi/simulator.mjs
npm --prefix frontend run build -- --mode vercel
