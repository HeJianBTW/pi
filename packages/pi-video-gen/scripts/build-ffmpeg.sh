#!/bin/sh
# Release-time build for the minimal LGPL FFmpeg platform packages.
set -eu

TARGET=${1:?usage: build-ffmpeg.sh <darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64>}
FFMPEG_VERSION=7.1.5
FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
ZLIB_VERSION=1.3.2
ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
X264_VERSION=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_SHA256=cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9
MACOSX_DEPLOYMENT_TARGET=11.0
SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
ZLIB_URL="https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz"
# zlib.net occasionally serves a bad payload to CI runners; the official
# madler/zlib GitHub release asset is byte-identical, so try it first and
# fall back to zlib.net. The pinned hash arbitrates every candidate.
ZLIB_URLS="https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz $ZLIB_URL"
X264_URL="https://code.videolan.org/videolan/x264/-/archive/$X264_VERSION/x264-$X264_VERSION.tar.gz"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)/platforms/ffmpeg-"$TARGET"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-video-gen-ffmpeg-${TARGET}.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

verify_sha256() {
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$1" "$2" | sha256sum -c -
  else
    printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c -
  fi
}

# ffmpeg.org is a single origin host with spotty reachability from CI
# runners; retry through transient connect failures (curl exit 28) instead
# of dying on the first attempt. --retry-all-errors needs curl 7.71+.
fetch() {
  curl -fsSL --retry 4 --retry-all-errors --connect-timeout 20 "$1" -o "$2"
}

case "$TARGET" in
  darwin-arm64)
    [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] ||
      { echo "$TARGET requires a Darwin arm64 host" >&2; exit 1; }
    CROSS_FLAGS=
    EXECUTABLE=ffmpeg
    export MACOSX_DEPLOYMENT_TARGET
    RUNTIME_BASELINE="macOS ${MACOSX_DEPLOYMENT_TARGET}+"
    ;;
  darwin-x64)
    [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = x86_64 ] ||
      { echo "$TARGET requires a Darwin x86_64 host" >&2; exit 1; }
    CROSS_FLAGS=
    EXECUTABLE=ffmpeg
    export MACOSX_DEPLOYMENT_TARGET
    RUNTIME_BASELINE="macOS ${MACOSX_DEPLOYMENT_TARGET}+"
    ;;
  linux-x64)
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] ||
      { echo "$TARGET requires a Linux x86_64 host" >&2; exit 1; }
    CROSS_FLAGS=
    EXECUTABLE=ffmpeg
    RUNTIME_BASELINE="Linux glibc (built on Ubuntu 22.04)"
    ;;
  linux-arm64)
    command -v aarch64-linux-gnu-gcc >/dev/null
    CROSS_FLAGS="--enable-cross-compile --target-os=linux --arch=aarch64 --cross-prefix=aarch64-linux-gnu- --pkg-config=pkg-config"
    EXECUTABLE=ffmpeg
    RUNTIME_BASELINE="Linux glibc (built on Ubuntu 22.04)"
    ;;
  win32-x64)
    command -v x86_64-w64-mingw32-gcc >/dev/null
    CROSS_FLAGS="--enable-cross-compile --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- --pkg-config=pkg-config --extra-ldflags=-static"
    EXECUTABLE=ffmpeg.exe
    RUNTIME_BASELINE="Windows x64"
    ;;
  *)
    echo "unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

fetch "$SOURCE_URL" "$WORK/ffmpeg.tar.xz"
verify_sha256 "$FFMPEG_SHA256" "$WORK/ffmpeg.tar.xz"
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK"

# PNG support requires zlib. Build the pinned static source for every target
# so cross builds do not depend on host development packages.
zlib_ok=
for url in $ZLIB_URLS; do
  if fetch "$url" "$WORK/zlib.tar.gz" && verify_sha256 "$ZLIB_SHA256" "$WORK/zlib.tar.gz"; then
    zlib_ok=1
    break
  fi
  echo "[build] zlib fetch failed or hash mismatch: $url" >&2
done
[ -n "$zlib_ok" ] || { echo "[build] all zlib mirrors failed" >&2; exit 1; }
tar -xzf "$WORK/zlib.tar.gz" -C "$WORK"
case "$TARGET" in
  linux-arm64) ZLIB_CHOST=aarch64-linux-gnu ;;
  win32-x64) ZLIB_CHOST=x86_64-w64-mingw32 ;;
  *) ZLIB_CHOST= ;;
esac
(
  cd "$WORK/zlib-${ZLIB_VERSION}"
  if [ -n "$ZLIB_CHOST" ]; then
    CHOST="$ZLIB_CHOST" ./configure --static --prefix="$WORK/zlib-install"
  else
    ./configure --static --prefix="$WORK/zlib-install"
  fi
  make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
  make install
)
export PKG_CONFIG_PATH="$WORK/zlib-install/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
ZLIB_FLAGS="--extra-cflags=-I$WORK/zlib-install/include --extra-ldflags=-L$WORK/zlib-install/lib"

cd "$WORK/ffmpeg-${FFMPEG_VERSION}"

# shellcheck disable=SC2086
# Extended for the timeline compose pipeline (C1-C3): image inputs, kenburns/
# xfade/overlay, mov_text soft subtitles, BGM mixing, QC frame extraction.
# The LGPL build has no third-party codec libraries; zlib is linked only for
# PNG support. The explicit GPL variant below additionally links x264.
FF_CONFIGURE_BASE="--disable-autodetect --disable-debug --disable-doc --disable-ffplay \
  --disable-everything --enable-ffmpeg --enable-zlib --enable-protocol=file \
  --enable-demuxer=concat,mov,mp4,m4a,mp3,wav,image2,srt \
  --enable-muxer=mp4,mov,image2 \
  --enable-decoder=h264,aac,mpeg4,mp3,pcm_s16le,pcm_u8,png,mjpeg,webp,gif,srt,wrapped_avframe \
  --enable-encoder=mpeg4,aac,pcm_s16le,png,movtext \
  --enable-parser=h264,aac,mpeg4video,mpegaudio \
  --enable-indev=lavfi \
  --enable-filter=copy,format,aformat,aresample,scale,crop,zoompan,xfade,overlay,pad,fade,amix,alimiter,volume,trim,atrim,concat,settb,setsar,fps,anullsrc,color,sine \
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc"

if [ "${GPL_VARIANT:-}" = "1" ]; then
  # GPL variant WITH x264 (H.264 output for web distribution). Builds x264
  # from the pinned videolan snapshot first. The resulting binary is GPL —
  # ship it as bin/ffmpeg-gpl with GPLv2 license files, NEVER as bin/ffmpeg.
  echo "[build] x264 variant: fetching $X264_URL"
  fetch "$X264_URL" "$WORK/x264.tar.gz"
  verify_sha256 "$X264_SHA256" "$WORK/x264.tar.gz"
  tar -xzf "$WORK/x264.tar.gz" -C "$WORK"
  # x264 derives its toolchain (CC/AR/RANLIB/...) from --cross-prefix; --host
  # alone only sets the target arch and would build with the HOST compiler.
  X264_CROSS_FLAGS=
  if [ -n "$CROSS_FLAGS" ]; then
    X264_CROSS_PREFIX=$(echo "$CROSS_FLAGS" | sed -n 's/.*--cross-prefix=\([^ ]*\).*/\1/p')
    [ -n "$X264_CROSS_PREFIX" ] ||
      { echo "no --cross-prefix found in CROSS_FLAGS: $CROSS_FLAGS" >&2; exit 1; }
    X264_CROSS_FLAGS="--host=${X264_CROSS_PREFIX%-} --cross-prefix=$X264_CROSS_PREFIX"
  fi
  (cd "$WORK/x264-$X264_VERSION" && \
    ./configure --prefix="$WORK/x264-install" --enable-static --disable-cli --disable-opencl --bit-depth=8 \
      $X264_CROSS_FLAGS && \
    make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)" && \
    make install)
  # ffmpeg's configure discovers x264 via pkg-config, not raw cflags.
  export PKG_CONFIG_PATH="$WORK/x264-install/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  X264_FLAGS="--enable-gpl --enable-libx264 --enable-encoder=libx264"
  echo "[build] configuring GPL variant (x264 $X264_VERSION)"
  ./configure $FF_CONFIGURE_BASE $ZLIB_FLAGS $X264_FLAGS $CROSS_FLAGS
else
  ./configure $FF_CONFIGURE_BASE $ZLIB_FLAGS $CROSS_FLAGS
fi
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)" "ffmpeg${EXECUTABLE#ffmpeg}" "ffprobe${EXECUTABLE#ffmpeg}"

mkdir -p "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/source"
cp "$WORK/zlib.tar.gz" "$PACKAGE_ROOT/source/zlib-${ZLIB_VERSION}.tar.gz"
cp "$WORK/zlib-${ZLIB_VERSION}/LICENSE" "$PACKAGE_ROOT/ZLIB_LICENSE.txt"

if [ "${GPL_VARIANT:-}" = "1" ]; then
  # GPL variant adds bin/ffmpeg-gpl(+ffprobe-gpl) to the EXISTING package
  # (LGPL base ffmpeg/ffprobe stay). Never ship a GPL binary under the plain
  # ffmpeg name.
  case "$EXECUTABLE" in
    *.exe)
      GPL_EXECUTABLE="ffmpeg-gpl.exe"
      GPL_PROBE="ffprobe-gpl.exe"
      ;;
    *)
      GPL_EXECUTABLE="ffmpeg-gpl"
      GPL_PROBE="ffprobe-gpl"
      ;;
  esac
  cp "ffmpeg${EXECUTABLE#ffmpeg}" "$PACKAGE_ROOT/bin/$GPL_EXECUTABLE"
  cp "ffprobe${EXECUTABLE#ffmpeg}" "$PACKAGE_ROOT/bin/$GPL_PROBE"
  chmod +x "$PACKAGE_ROOT/bin/$GPL_EXECUTABLE" "$PACKAGE_ROOT/bin/$GPL_PROBE"
  cp "$WORK/ffmpeg-${FFMPEG_VERSION}/COPYING.GPLv2" "$PACKAGE_ROOT/GPLv2.txt"
  cp "$WORK/x264.tar.gz" "$PACKAGE_ROOT/source/x264-${X264_VERSION}.tar.gz"
  # GPL provenance is a SEPARATE section (do NOT append to the LGPL SOURCE.md
  # written by the base pass — rewrite it to keep both binaries documented).
  cat > "$PACKAGE_ROOT/SOURCE.md" <<EOF
# FFmpeg binaries — source and build provenance

This package ships TWO FFmpeg binaries for \`$TARGET\`:

| Binary | Purpose | License |
|---|---|---|
| \`bin/ffmpeg\` (+\`ffprobe\`) | concat/streams, mpeg4 timeline pipeline | LGPL-2.1-or-later |
| \`bin/ffmpeg-gpl\` (+\`ffprobe-gpl\`) | H.264 output (libx264) | GPL-2.0-or-later |

- FFmpeg source archive: $SOURCE_URL
- FFmpeg source SHA-256: \`$FFMPEG_SHA256\`
- zlib source: \`source/zlib-${ZLIB_VERSION}.tar.gz\` (SHA-256 \`$ZLIB_SHA256\`, license in \`ZLIB_LICENSE.txt\`)
- x264 snapshot: \`$X264_VERSION\` (see \`source/x264-${X264_VERSION}.tar.gz\` and \`GPLv2.txt\`)
- Bundled build script: \`source/build-ffmpeg.sh\`
- Runtime baseline: $RUNTIME_BASELINE
EOF
else
  cp "ffmpeg${EXECUTABLE#ffmpeg}" "$PACKAGE_ROOT/bin/$EXECUTABLE"
  case "$EXECUTABLE" in
    *.exe) PROBE_EXECUTABLE="ffprobe.exe" ;;
    *) PROBE_EXECUTABLE="ffprobe" ;;
  esac
  cp "ffprobe${EXECUTABLE#ffmpeg}" "$PACKAGE_ROOT/bin/$PROBE_EXECUTABLE"
  chmod +x "$PACKAGE_ROOT/bin/$EXECUTABLE" "$PACKAGE_ROOT/bin/$PROBE_EXECUTABLE"
  cp COPYING.LGPLv2.1 "$PACKAGE_ROOT/LICENSE"
  cp "$WORK/ffmpeg.tar.xz" "$PACKAGE_ROOT/source/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  cat > "$PACKAGE_ROOT/SOURCE.md" <<EOF
# FFmpeg source and build provenance

- Target: \`$TARGET\`
- Runtime baseline: $RUNTIME_BASELINE
- Source archive: $SOURCE_URL
- Source SHA-256: \`$FFMPEG_SHA256\`
- zlib source: \`source/zlib-${ZLIB_VERSION}.tar.gz\` (SHA-256 \`$ZLIB_SHA256\`, license in \`ZLIB_LICENSE.txt\`)
- Bundled build script: \`source/build-ffmpeg.sh\` (builds both ffmpeg and ffprobe)
- License: LGPL-2.1-or-later
- This binary was built with \`--disable-autodetect --disable-everything\`; zlib is statically linked for PNG support.
EOF
fi
cp "$SCRIPT_DIR/build-ffmpeg.sh" "$PACKAGE_ROOT/source/build-ffmpeg.sh"
