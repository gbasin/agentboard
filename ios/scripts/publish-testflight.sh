#!/bin/bash
# Sign in an ephemeral keychain, archive, and export/upload an internal build.
set -euo pipefail
set +x
# Xcode invokes Apple rsync, whose child must also resolve to Apple rsync.
# A Homebrew rsync first in PATH rejects Apple extended-attribute flags.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$(dirname "$0")/../.."
for name in IOS_TEAM_ID IOS_BUILD_NUMBER IOS_VERSION IOS_SIGNING_P12_BASE64 IOS_SIGNING_P12_PASSWORD IOS_PROFILE_BASE64 ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY; do
  if [ -z "${!name:-}" ]; then echo "Missing publishing credential/setting: $name" >&2; exit 1; fi
done
case "${IOS_PUBLISH:-false}" in true) destination=upload ;; false) destination='export' ;; *) echo 'IOS_PUBLISH must be true or false' >&2; exit 1 ;; esac
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]{0,3}\.[1-9][0-9]?$ ]] || { echo 'Invalid build number' >&2; exit 1; }
[[ "$IOS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version' >&2; exit 1; }
[ "$(tr -d '\n\r' < ios/version.txt)" = "$IOS_VERSION" ] || { echo 'Version differs from source' >&2; exit 1; }
umask 077
signing_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentboard-signing.XXXXXX")
keychain="$signing_dir/signing.keychain-db"
keychain_password=$(openssl rand -hex 32)
profile_path=''
previous_keychains=()
while IFS= read -r line; do previous_keychains+=("$line"); done < <(security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
cleanup() {
  security list-keychains -d user -s "${previous_keychains[@]}" || true
  security delete-keychain "$keychain" 2>/dev/null || true
  if [ -n "$profile_path" ]; then rm -f "$profile_path"; fi
  rm -rf "$signing_dir"
}
trap cleanup EXIT
printf '%s' "$IOS_SIGNING_P12_BASE64" | base64 --decode > "$signing_dir/signing.p12"
printf '%s' "$IOS_PROFILE_BASE64" | base64 --decode > "$signing_dir/profile.mobileprovision"
printf '%s' "$ASC_PRIVATE_KEY" > "$signing_dir/AuthKey.p8"
unset IOS_SIGNING_P12_BASE64 IOS_PROFILE_BASE64 ASC_PRIVATE_KEY
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/signing.p12" -P "$IOS_SIGNING_P12_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
unset IOS_SIGNING_P12_PASSWORD
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${previous_keychains[@]}"
security cms -D -i "$signing_dir/profile.mobileprovision" > "$signing_dir/profile.plist"
export SIGNING_PROFILE_PLIST="$signing_dir/profile.plist"
profile_uuid=$(python3 - <<'PY'
import datetime, os, plistlib
with open(os.environ['SIGNING_PROFILE_PLIST'], 'rb') as f: profile = plistlib.load(f)
team = os.environ['IOS_TEAM_ID']
assert profile['TeamIdentifier'] == [team], 'Wrong signing team'
assert profile['Entitlements']['application-identifier'] == team + '.dev.agentboard.ios-spike', 'Wrong bundle identifier'
assert not profile['Entitlements'].get('get-task-allow', False), 'Development profile cannot distribute'
assert 'ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices'), 'Expected App Store profile'
assert profile['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Expired profile'
print(profile['UUID'])
PY
)
profile_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profile_dir"
profile_path="$profile_dir/$profile_uuid.mobileprovision"
# Never overwrite a profile belonging to an interactive Xcode session.
if [ -e "$profile_path" ]; then echo 'Profile already installed; use a clean CI runner' >&2; profile_path=''; exit 1; fi
cp "$signing_dir/profile.mobileprovision" "$profile_path"
output_dir="ios/.build-testflight/$IOS_BUILD_NUMBER"
[ ! -e "$output_dir" ] || { echo 'Build output exists; use a new build number' >&2; exit 1; }
mkdir -p "$output_dir"
./ios/scripts/prepare.sh
xcodebuild -quiet -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$output_dir/Agentboard.xcarchive" -derivedDataPath ios/.build-testflight/DerivedData \
  "DEVELOPMENT_TEAM=$IOS_TEAM_ID" CODE_SIGN_STYLE=Manual 'CODE_SIGN_IDENTITY=Apple Distribution' \
  "PROVISIONING_PROFILE_SPECIFIER=$profile_uuid" "CURRENT_PROJECT_VERSION=$IOS_BUILD_NUMBER" \
  "MARKETING_VERSION=$IOS_VERSION" INJECTION_RESOURCES= archive > "$output_dir/archive.log" 2>&1 || {
    tail -60 "$output_dir/archive.log" >&2; exit 1;
  }
codesign --verify --deep --strict "$output_dir/Agentboard.xcarchive/Products/Applications/AgentboardSpike.app"
export IOS_EXPORT_DESTINATION="$destination" IOS_PROFILE_UUID="$profile_uuid" IOS_EXPORT_PLIST="$signing_dir/ExportOptions.plist"
python3 - <<'PY'
import os, plistlib
options = dict(method='app-store-connect', destination=os.environ['IOS_EXPORT_DESTINATION'],
  teamID=os.environ['IOS_TEAM_ID'], signingStyle='manual', signingCertificate='Apple Distribution',
  provisioningProfiles={'dev.agentboard.ios-spike':os.environ['IOS_PROFILE_UUID']},
  testFlightInternalTestingOnly=True, manageAppVersionAndBuildNumber=False, uploadSymbols=True)
with open(os.environ['IOS_EXPORT_PLIST'], 'wb') as f: plistlib.dump(options, f)
PY
xcodebuild -exportArchive -archivePath "$output_dir/Agentboard.xcarchive" \
  -exportOptionsPlist "$IOS_EXPORT_PLIST" -exportPath "$output_dir/export" \
  -authenticationKeyPath "$signing_dir/AuthKey.p8" -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" > "$output_dir/export.log" 2>&1 || {
    tail -60 "$output_dir/export.log" >&2; exit 1;
  }
if [ "$destination" = upload ]; then
  ASC_PRIVATE_KEY_PATH="$signing_dir/AuthKey.p8" bun ios/scripts/testflight-status.ts
else
  echo "Signed export ready at $output_dir/export; nothing uploaded."
fi
