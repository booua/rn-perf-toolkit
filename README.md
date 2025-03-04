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
- `--iterations <number>`: Number of test iterations to run (default: 3)
- `--output <directory>`: Directory to save test results (default: ./performance_traces)
- `--marker <marker-name>`: Add a custom marker to track (can be used multiple times)
- `--paired-marker <start-marker> <end-marker> <name>`: Add a paired marker to measure duration (can be used multiple times)


## Adding Performance Markers to Your React Native App

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