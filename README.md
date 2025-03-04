# React Native Performance Measurement Tool

A neat little tool for measuring and analyzing the performance of React Native applications on Android devices. Aims to be as repeatable as possible.

## Features

- Measures app startup time and activity lifecycle events
- Supports custom performance markers for specific events
- Supports paired markers to measure durations of specific operations (e.g., screen transitions)
- Captures frame rate and jank statistics
- Generates detailed reports for each test run and summary reports across multiple runs
- All metrics are measured relative to app launch time (t=0)

## Requirements

- Deno runtime
- Android device or emulator with USB debugging enabled
- ADB installed and in your PATH

## Installation

1. Install Deno: https://deno.land/manual/getting_started/installation
2. Clone this repository
3. Make the script executable: `chmod +x measure_performance.ts`

## Usage

```deno
deno run --allow-run --allow-read --allow-write measure_performance.ts [options]
```

### Options

- `--package <package-name>`: Android package name of the app to test (default: com.example.app)
- `--activity <activity-name>`: Android activity name (default: {package}.MainActivity)
- `--iterations <number>`: Number of test iterations to run (default: 3)
- `--trace-duration <seconds>`: Duration of trace capture in seconds (default: 30)
- `--output <directory>`: Directory to save test results (default: ./performance_traces)
- `--marker <marker-name>`: Add a custom marker to track (can be used multiple times)
- `--paired-marker <start-marker> <end-marker> <name>`: Add a paired marker to measure duration (can be used multiple times)
- `--env <file-path>`: Use a specific environment file instead of the default .env
- `--markers-config <file-path>`: Use a specific markers configuration file

### Examples

```bash
# Basic usage with default settings
deno run --allow-run --allow-read --allow-write measure_performance.ts

# Test a specific app with 5 iterations
deno run --allow-run --allow-read --allow-write measure_performance.ts --package com.mycompany.myapp --iterations 5

# Track custom markers
deno run --allow-run --allow-read --allow-write measure_performance.ts --marker app_loaded --marker feed_rendered

# Track paired markers for measuring specific operations
deno run --allow-run --allow-read --allow-write measure_performance.ts --paired-marker feed_tap_start feed_loaded feed_navigation
```

## Adding Performance Markers to Your React Native App

### JavaScript Markers

To add performance markers in your JavaScript code, use the PerfettoTracer API:

```javascript

// Add a simple marker
PerfettoTracer.beginTrace('TEST_EVENT_MANUAL');
PerfettoTracer.beginTrace('app_js_initialized');

// For paired markers (start of an operation)
PerfettoTracer.beginTrace('trace_watchlist_tap_start');

// For paired markers (end of an operation)
PerfettoTracer.beginTrace('trace_watchlist_fully_loaded_end');
```

### Native Markers (Java/Kotlin)

For native code, you can use the Android Trace API:

```kotlin
import android.os.Trace;

// Start a section
Trace.beginSection("trace_native_operation_start");

// End the most recent section
Trace.endSection();
```

### Paired Markers

Paired markers allow you to measure the duration of specific operations:

- `trace_watchlist_tap_start` and `trace_watchlist_fully_loaded_end`: Measures watchlist loading time
- `trace_article_tap_start` and `trace_article_fully_loaded_end`: Measures article loading time

You can define your own paired markers using the `--paired-marker` option.

## Understanding the Results

The tool generates two types of reports:

1. **Individual run reports** (`metrics_X.txt`): Detailed metrics for each test iteration
2. **Summary report** (`summary_report.txt`): Aggregated metrics across all successful test runs

All timing measurements use the Activity Manager START intent as the reference start time (t=0). This is when the system begins the process of starting your application.

### Key Metrics

- **Activity Lifecycle Events**: Time to create, start, resume, and fully draw the activity
- **Custom Markers**: Time from app start to each custom marker
- **Paired Markers**: Duration between start and end markers for specific operations
- **Frame Statistics**: Average FPS, frame duration, and jank percentages

## License

MIT

## Troubleshooting

### Markers Not Appearing in Trace

If your markers (like TEST_EVENT_MANUAL) are not appearing in the trace:

1. **Check marker implementation**: Ensure you're using the correct API call in your app:
   ```javascript
   PerfettoTracer.beginTrace('TEST_EVENT_MANUAL');
   ```

2. **Verify trace categories**: Make sure the tool is capturing the right trace categories. The default categories should work for most cases, but you can modify them in the code if needed.

3. **Check timing**: Ensure your markers are being triggered during the trace capture window. The default trace duration is 30 seconds.

4. **Examine raw trace**: Look at the raw trace files in the output directory to see if the markers are present but not being detected by the parsing logic.

5. **Try alternative marker patterns**: The tool tries multiple patterns to find markers. You can add more patterns in the `processTraceData` function if needed.

### ADB Connection Issues

- Ensure USB debugging is enabled on your device
- Check that your device is properly connected and authorized
- Run `adb devices` to verify the device is detected
- Try restarting the ADB server with `adb kill-server` followed by `adb start-server`

### Permission Issues

If you encounter permission errors when running atrace commands:

- Make sure your device is not in a restricted mode
- Try running the tool with elevated privileges if needed
- Some devices may require root access for certain trace operations

## Configuration

You can configure the tool in three ways:

1. **Command line arguments**: Provide options when running the tool
2. **Environment file**: Create a `.env` file with your configuration
3. **Custom environment file**: Specify a custom environment file with `--env`

### Environment File Configuration

Create a `.env` file in the same directory as the script (or copy from `.env.example`):

```
# App package name (required)
APP_PACKAGE=com.example.app

# App activity name (optional)
APP_ACTIVITY=com.example.app.MainActivity

# Number of test iterations
ITERATIONS=3

# Trace duration in seconds
TRACE_DURATION=30

# Markers configuration file
MARKERS_CONFIG=markers.json
```

### Markers Configuration

The tool uses a JSON file to define custom markers and paired markers. By default, it looks for `markers.json` in the current directory, but you can specify a different file in the `.env` file or with the `--markers-config` command line option.

Example `markers.json`:

```json
{
  "customMarkers": [
    "TEST_EVENT_MANUAL",
    "app_js_initialized",
    "first_screen_mounted",
    "feed_loaded"
  ],
  "pairedMarkers": [
    {
      "start": "trace_watchlist_tap_start",
      "end": "trace_watchlist_fully_loaded_end",
      "name": "watchlist_load"
    },
    {
      "start": "trace_article_tap_start",
      "end": "trace_article_fully_loaded_end",
      "name": "article_load"
    }
  ]
}
```

### Using Different Environment Files

You can create multiple environment files for different apps or environments:

```bash
# Use a specific environment file
deno run --allow-run --allow-read --allow-write measure_performance.ts --env .env.production

# Use a specific environment file for a different app
deno run --allow-run --allow-read --allow-write measure_performance.ts --env .env.bloomberg
```

### Using Different Markers Configuration Files

You can create multiple markers configuration files for different apps or scenarios:

```bash
# Use a specific markers configuration file
deno run --allow-run --allow-read --allow-write measure_performance.ts --markers-config markers.bloomberg.json
```