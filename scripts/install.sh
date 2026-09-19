#!/usr/bin/env bash
set -euo pipefail

repository="${SNAPPYDIFF_RELEASE_REPOSITORY:-phil1995/SnappyDiff}"
version="${SNAPPYDIFF_VERSION:-latest}"
install_dir="${SNAPPYDIFF_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
  *) echo "SnappyDiff does not publish a binary for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$version" == "latest" ]]; then
  base_url="https://github.com/$repository/releases/latest/download"
else
  base_url="https://github.com/$repository/releases/download/$version"
fi

archive="snappydiff-$target.tar.gz"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

curl --fail --silent --show-error --location "$base_url/$archive" --output "$temporary/$archive"
curl --fail --silent --show-error --location "$base_url/checksums.txt" --output "$temporary/checksums.txt"

expected="$(awk -v archive="$archive" '$2 == archive { print $1 }' "$temporary/checksums.txt")"
if [[ -z "$expected" ]]; then
  echo "No checksum was published for $archive" >&2
  exit 1
fi
actual="$(shasum -a 256 "$temporary/$archive" | awk '{ print $1 }')"
if [[ "$actual" != "$expected" ]]; then
  echo "Checksum verification failed for $archive" >&2
  exit 1
fi

tar -xzf "$temporary/$archive" -C "$temporary"
mkdir -p "$install_dir"
install -m 0755 "$temporary/snappydiff" "$install_dir/snappydiff"
echo "Installed snappydiff to $install_dir/snappydiff"
