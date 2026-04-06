#!/bin/bash
ADB="adb -s localhost:5555"
API_LEVEL=$($ADB shell getprop ro.build.version.sdk | tr -d '\r')

# Enable location
$ADB shell settings put secure location_mode 3
$ADB shell cmd location set-location-enabled true 2>/dev/null

# Grant mock location to shell
$ADB shell appops set shell android:mock_location allow 2>/dev/null
$ADB shell appops set com.android.shell android:mock_location allow 2>/dev/null

if [ "$API_LEVEL" -ge 31 ]; then
    # Android 12+ (API 31+)
    $ADB shell cmd location providers add-test-provider gps --supportsAltitude --supportsSpeed --supportsBearing 2>/dev/null
    $ADB shell cmd location providers set-test-provider-enabled gps true 2>/dev/null
    $ADB shell cmd location providers set-test-provider-location gps --location 55.7558,37.6173 --accuracy 10 2>/dev/null
    $ADB shell cmd location providers add-test-provider network 2>/dev/null
    $ADB shell cmd location providers set-test-provider-enabled network true 2>/dev/null
    $ADB shell cmd location providers set-test-provider-location network --location 55.7558,37.6173 --accuracy 100 2>/dev/null
else
    # Android 11 and below — set timezone + locale for Russia
    $ADB shell settings put global auto_time_zone 0
    $ADB shell setprop persist.sys.timezone Europe/Moscow
    $ADB shell settings put system time_12_24 24
fi

echo "GPS/locale set to Moscow (API level $API_LEVEL)"
