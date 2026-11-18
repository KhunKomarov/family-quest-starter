#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$root/scripts/configure.py"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
tools="${FAMILY_BUILD_TOOLS:-$sdk/build-tools/35.0.0}"
android_jar="${FAMILY_ANDROID_JAR:-$sdk/platforms/android-35/android.jar}"
if [[ ! -x "$tools/aapt2" || ! -f "$android_jar" ]]; then
  echo "Install Android SDK Platform 35 and Build Tools 35.0.0 and set ANDROID_HOME." >&2
  exit 1
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
output="${2:-$root/.local/apk/family-quest-preview.apk}"
private="$root/.local"
work="$(mktemp -d)"
staged_apk=""
cleanup() {
  python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$work"
  if [[ -n "$staged_apk" ]]; then
    unlink "$staged_apk"
  fi
}
trap cleanup EXIT
mkdir -p "$private" "$(dirname "$output")" "$work/classes" "$work/dex" "$work/assets"
key="$private/signing.p12"
password="$private/signing.pass"
if [[ ! -f "$key" ]]; then
  if [[ ! -e "$password" ]]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_hex(24))' > "$password")
  fi
  (umask 077; keytool -genkeypair -keystore "$key" -storetype PKCS12 \
    -storepass:file "$password" -alias family-quest -keyalg RSA -keysize 3072 \
    -validity 10000 -dname "CN=Family Quest")
fi
cp -R "$root/web/." "$work/assets/"
if [[ -n "${1:-}" ]]; then
  cp "$1" "$work/assets/sync.properties"
fi
"$tools/aapt2" compile --dir "$root/res" -o "$work/resources.zip"
"$tools/aapt2" link -I "$android_jar" --manifest "$root/AndroidManifest.xml" \
  -A "$work/assets" -o "$work/unsigned.apk" "$work/resources.zip"
javac --release 8 -encoding UTF-8 -classpath "$android_jar" -d "$work/classes" \
  "$root/src/org/familyquest/starter/"*.java
jar cf "$work/classes.jar" -C "$work/classes" .
"$tools/d8" --release --min-api 28 --lib "$android_jar" --output "$work/dex" "$work/classes.jar"
zip -q -j "$work/unsigned.apk" "$work/dex/classes.dex"
"$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$key" --ks-pass "file:$password" --ks-key-alias family-quest \
  --v2-signing-enabled true --out "$work/signed.apk" "$work/aligned.apk"
"$tools/apksigner" verify "$work/signed.apk"
staged_apk="$(mktemp "$(dirname "$output")/.family-quest.XXXXXX")"
cat "$work/signed.apk" > "$staged_apk"
mv -f "$staged_apk" "$output"
staged_apk=""
printf 'APK: %s\n' "$output"
