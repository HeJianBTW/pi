#!/bin/sh
# Release-time build for the minimal LGPL FFmpeg platform packages.
set -eu

TARGET=${1:?usage: build-ffmpeg.sh <darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64>}
FFMPEG_VERSION=7.1.5
FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
MACOSX_DEPLOYMENT_TARGET=11.0
SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)/platforms/ffmpeg-"$TARGET"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-video-gen-ffmpeg-${TARGET}.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

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
    CROSS_FLAGS="--enable-cross-compile --target-os=linux --arch=aarch64 --cross-prefix=aarch64-linux-gnu-"
    EXECUTABLE=ffmpeg
    RUNTIME_BASELINE="Linux glibc (built on Ubuntu 22.04)"
    ;;
  win32-x64)
    command -v x86_64-w64-mingw32-gcc >/dev/null
    CROSS_FLAGS="--enable-cross-compile --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- --extra-ldflags=-static"
    EXECUTABLE=ffmpeg.exe
    RUNTIME_BASELINE="Windows x64"
    ;;
  *)
    echo "unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

curl -fsSL "$SOURCE_URL" -o "$WORK/ffmpeg.tar.xz"
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$FFMPEG_SHA256" "$WORK/ffmpeg.tar.xz" | sha256sum -c -
else
  printf '%s  %s\n' "$FFMPEG_SHA256" "$WORK/ffmpeg.tar.xz" | shasum -a 256 -c -
fi
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-${FFMPEG_VERSION}"

# No third-party codec libraries: the shipped FFmpeg source archive is the
# complete corresponding source for these binaries. OS system libraries may
# still appear in the native binary's load commands.
# shellcheck disable=SC2086
./configure \
  --disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-everything --enable-ffmpeg --enable-protocol=file \
  --enable-demuxer=concat,mov,mp4,m4a,mp3,wav \
  --enable-muxer=mp4,mov \
  --enable-decoder=h264,aac,mpeg4,mp3,pcm_s16le \
  --enable-encoder=mpeg4,aac,pcm_s16le \
  --enable-parser=h264,aac,mpeg4video,mpegaudio \
  --enable-filter=copy,format,aformat,aresample,scale \
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc \
  $CROSS_FLAGS
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)" ffmpeg

rm -rf "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/source"
mkdir -p "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/source"
cp "ffmpeg${EXECUTABLE#ffmpeg}" "$PACKAGE_ROOT/bin/$EXECUTABLE"
chmod +x "$PACKAGE_ROOT/bin/$EXECUTABLE"
cp COPYING.LGPLv2.1 "$PACKAGE_ROOT/LICENSE"
cp "$WORK/ffmpeg.tar.xz" "$PACKAGE_ROOT/source/ffmpeg-${FFMPEG_VERSION}.tar.xz"
cp "$SCRIPT_DIR/build-ffmpeg.sh" "$PACKAGE_ROOT/source/build-ffmpeg.sh"

cat > "$PACKAGE_ROOT/SOURCE.md" <<EOF
# FFmpeg source and build provenance

- Target: \`$TARGET\`
- Runtime baseline: $RUNTIME_BASELINE
- Source archive: $SOURCE_URL
- Source SHA-256: \`$FFMPEG_SHA256\`
- Bundled corresponding source: \`source/ffmpeg-${FFMPEG_VERSION}.tar.xz\`
- Bundled build script: \`source/build-ffmpeg.sh\`
- License: LGPL-2.1-or-later

This binary was built with \`--disable-autodetect --disable-everything\` and no
third-party codec libraries. The exact corresponding FFmpeg source and build
script are shipped together in this npm package.
EOF
