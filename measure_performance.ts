#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

import { parse as parseArgs } from "https://deno.land/std@0.224.0/flags/mod.ts";

const PACKAGE_NAME = "com.bloomberg.android.plus";

interface PairedMarker {
  start: string;
  end: string;
  name: string;
}

interface Config {
  appPackage: string;
  appActivity: string;
  iterations: number;
  traceDuration: number;
  outputDir: string;
  deviceTracePath: string;
  customMarkers: string[];
  pairedMarkers: PairedMarker[];
  traceCategories: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  options: { stderr?: "piped" | "null" } = {}
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  console.log(`Running command: ${cmd} ${args.join(" ")}`);

  try {
    const process = new Deno.Command(cmd, {
      args: args,
      stdout: "piped",
      stderr: options.stderr === "null" ? "null" : "piped",
    });

    const output = await process.output();

    const textDecoder = new TextDecoder();
    const stdoutText = textDecoder.decode(output.stdout);
    const stderrText = textDecoder.decode(output.stderr);

    if (!output.success) {
      console.error(`Command failed with exit code ${output.code}`);
      if (stderrText) console.error(`Error: ${stderrText}`);
    }

    return {
      success: output.success,
      stdout: stdoutText,
      stderr: stderrText,
    };
  } catch (error) {
    console.error(`Failed to execute command: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDeviceConnected(): Promise<boolean> {
  const { success, stdout } = await runCommand("adb", ["devices"]);
  if (!success) return false;

  const lines = stdout.trim().split("\n");
  return lines.length > 1 && lines[1].includes("device");
}

async function clearAppData(appPackage: string): Promise<boolean> {
  console.log("Clearing app data...");
  const { success } = await runCommand("adb", ["shell", "pm", "clear", appPackage]);
  return success;
}

async function startTrace(config: Config): Promise<boolean> {
  console.log("Starting trace capture...");

  // Use the exact same approach as the shell script
  const { success, stderr } = await runCommand("adb", [
    "shell",
    `atrace --async_start -a ${config.appPackage} -b 16000 -c ${config.traceCategories}`
  ]);

  if (!success) {
    console.error(`Failed to start trace: ${stderr}`);
    return false;
  }

  console.log("Trace capture started");
  return true;
}

async function stopTrace(config: Config): Promise<boolean> {
  console.log("Stopping trace capture...");

  // Use the exact same approach as the shell script
  const { success, stderr } = await runCommand("adb", [
    "shell",
    `atrace --async_stop -o ${config.deviceTracePath}`
  ]);

  if (!success) {
    console.error(`Failed to stop trace: ${stderr}`);
    return false;
  }

  console.log("Trace capture stopped");
  return true;
}

async function launchApp(config: Config): Promise<string> {
  console.log("Launching app...");
  const activityName = config.appActivity || `${config.appPackage}.MainActivity`;
  const { success, stdout, stderr } = await runCommand("adb", [
    "shell",
    "am",
    "start-activity",
    "-W",
    `${config.appPackage}/${activityName}`
  ]);

  if (!success) {
    console.error(`Failed to launch app: ${stderr}`);
    return "";
  }

  return stdout;
}

async function takeScreenshot(outputPath: string): Promise<boolean> {
  console.log("Taking screenshot...");
  const tempPath = "/sdcard/screen_temp.png";

  const screencap = await runCommand("adb", ["shell", "screencap", "-p", tempPath]);
  if (!screencap.success) return false;

  const pull = await runCommand("adb", ["pull", tempPath, outputPath]);
  if (!pull.success) return false;

  await runCommand("adb", ["shell", "rm", tempPath]);
  return true;
}

async function pullTraceFile(config: Config, localPath: string): Promise<boolean> {
  console.log("Pulling trace file...");

  // Use the exact same approach as the shell script
  const { success, stderr } = await runCommand("adb", ["pull", config.deviceTracePath, localPath]);

  if (!success) {
    console.error(`Failed to pull trace file: ${stderr}`);
    return false;
  }

  console.log(`Successfully pulled trace file to ${localPath}`);
  return true;
}

async function getDeviceInfo(): Promise<Record<string, string>> {
  console.log("Getting device information...");
  const info: Record<string, string> = {};

  // Get device model
  const modelResult = await runCommand("adb", ["shell", "getprop", "ro.product.model"]);
  if (modelResult.success) {
    info.model = modelResult.stdout.trim();
  }

  // Get Android version
  const versionResult = await runCommand("adb", ["shell", "getprop", "ro.build.version.release"]);
  if (versionResult.success) {
    info.androidVersion = versionResult.stdout.trim();
  }

  return info;
}

async function processTraceData(config: Config, tracePath: string, iteration: number): Promise<void> {
  console.log(`Processing trace data from ${tracePath}...`);

  const metricsPath = `${config.outputDir}/metrics_${iteration}.txt`;

  // Create a metrics file
  let metricsContent = "=== Performance Metrics ===\n";
  metricsContent += `App Package: ${config.appPackage}\n`;
  metricsContent += `Trace File: ${tracePath}\n\n`;

  try {
    const traceContent = await Deno.readTextFile(tracePath);

    // Check for custom markers
    metricsContent += "== Custom Markers ==\n";
    for (const marker of config.customMarkers) {
      if (traceContent.includes(marker)) {
        metricsContent += `Found marker: ${marker}\n`;
      } else {
        metricsContent += `Marker not found: ${marker}\n`;
      }
    }

    // Check for paired markers
    if (config.pairedMarkers.length > 0) {
      metricsContent += "\n== Paired Markers ==\n";
      for (const pair of config.pairedMarkers) {
        metricsContent += `=== ${pair.name} ===\n`;

        const startFound = traceContent.includes(pair.start);
        const endFound = traceContent.includes(pair.end);

        metricsContent += `Start marker (${pair.start}): ${startFound ? "Found" : "Not found"}\n`;
        metricsContent += `End marker (${pair.end}): ${endFound ? "Found" : "Not found"}\n`;

        if (startFound && endFound) {
          metricsContent += `Both markers found for ${pair.name}\n`;
        } else {
          metricsContent += `Incomplete marker pair for ${pair.name}\n`;
        }

        metricsContent += "\n";
      }
    }

    await Deno.writeTextFile(metricsPath, metricsContent);
    console.log(`Metrics saved to ${metricsPath}`);
  } catch (error) {
    console.error(`Error processing trace data: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeMetricsToFile(
  metricsFile: string,
  metrics: Record<string, number>,
  config: Config
): Promise<void> {
  let content = "===== App Performance Metrics =====\n";
  content += `Date: ${new Date().toISOString()}\n`;
  content += `Device: ${(await getDeviceInfo()).model || "Unknown"}\n`;
  content += `App Package: ${config.appPackage}\n\n`;

  content += "== Measurement Reference Point ==\n";
  content += "All timing measurements use the Activity Manager START intent as the reference start time (t=0).\n";
  content += "This is when the system begins the process of starting your application.\n";
  content += "All relative times are measured from this point.\n\n";

  content += "== Android Activity Lifecycle Events ==\n";
  if (metrics.appStartTimestamp) {
    content += `Activity start intent time: ${metrics.appStartTimestamp.toFixed(3)} seconds (absolute time)\n`;
    content += `This is our t=0 reference point for all relative measurements.\n`;
  } else {
    content += "Activity start intent time: Not found in trace\n";
  }

  if (metrics.activityCreateTimestamp) {
    content += `Activity performCreate time: ${metrics.activityCreateTimestamp.toFixed(3)} seconds (absolute time)\n`;
  } else {
    content += "Activity performCreate time: Not found in trace\n";
  }

  if (metrics.activityStartTimestamp) {
    content += `Activity performStart time: ${metrics.activityStartTimestamp.toFixed(3)} seconds (absolute time)\n`;
  } else {
    content += "Activity performStart time: Not found in trace\n";
  }

  if (metrics.activityResumeTimestamp) {
    content += `Activity performResume time: ${metrics.activityResumeTimestamp.toFixed(3)} seconds (absolute time)\n`;
  } else {
    content += "Activity performResume time: Not found in trace\n";
  }

  if (metrics.activityDrawnTimestamp) {
    content += `Activity fully drawn time: ${metrics.activityDrawnTimestamp.toFixed(3)} seconds (absolute time)\n`;
  } else {
    content += "Activity fully drawn time: Not found in trace\n";
  }

  content += "\n== Time from App Launch to Activity Lifecycle Events ==\n";
  if (metrics.timeToCreate) {
    content += `Time from intent to performCreate: ${metrics.timeToCreate.toFixed(3)} seconds\n`;
  }

  if (metrics.timeToStart) {
    content += `Time from intent to performStart: ${metrics.timeToStart.toFixed(3)} seconds\n`;
  }

  if (metrics.timeToResume) {
    content += `Time from intent to performResume: ${metrics.timeToResume.toFixed(3)} seconds\n`;
  }

  if (metrics.timeToFullyDrawn) {
    content += `Total time to fully drawn: ${metrics.timeToFullyDrawn.toFixed(3)} seconds\n`;
  }

  content += "\n== Custom Performance Markers ==\n";
  for (const marker of config.customMarkers) {
    const markerTimestamp = metrics[`${marker}Timestamp`];
    if (markerTimestamp) {
      content += `${marker} marker time: ${markerTimestamp.toFixed(3)} seconds (absolute time)\n`;
    } else {
      content += `${marker} marker: Not found in trace\n`;
    }
  }

  content += "\n== Time from App Launch to Custom Markers ==\n";
  for (const marker of config.customMarkers) {
    const timeToMarker = metrics[`timeTo${marker}`];
    if (timeToMarker) {
      content += `Time from app start to ${marker}: ${timeToMarker.toFixed(3)} seconds\n`;
    }
  }

  if (config.pairedMarkers.length > 0) {
    content += "\n== Paired Markers (Start/End) ==\n";
    for (const pair of config.pairedMarkers) {
      const startTimestamp = metrics[`${pair.start}Timestamp`];
      const endTimestamp = metrics[`${pair.end}Timestamp`];
      const duration = metrics[`${pair.name}Duration`];

      content += `=== ${pair.name} ===\n`;

      if (startTimestamp) {
        content += `${pair.start} time: ${startTimestamp.toFixed(3)} seconds (absolute time)\n`;

        const timeToStart = metrics[`timeTo${pair.start}`];
        if (timeToStart) {
          content += `Time from app start to ${pair.start}: ${timeToStart.toFixed(3)} seconds\n`;
        }
      } else {
        content += `${pair.start}: Not found in trace\n`;
      }

      if (endTimestamp) {
        content += `${pair.end} time: ${endTimestamp.toFixed(3)} seconds (absolute time)\n`;

        const timeToEnd = metrics[`timeTo${pair.end}`];
        if (timeToEnd) {
          content += `Time from app start to ${pair.end}: ${timeToEnd.toFixed(3)} seconds\n`;
        }
      } else {
        content += `${pair.end}: Not found in trace\n`;
      }

      if (duration) {
        content += `Duration of ${pair.name}: ${duration.toFixed(3)} seconds\n`;
      } else if (startTimestamp && endTimestamp) {
        content += `Duration of ${pair.name}: ${(endTimestamp - startTimestamp).toFixed(3)} seconds\n`;
      } else {
        content += `Duration of ${pair.name}: Could not be calculated\n`;
      }

      content += "\n";
    }
  }

  content += "== Frame Rendering Performance ==\n";

  if (metrics.totalFrames) {
    content += `Total frames captured: ${metrics.totalFrames}\n`;
  } else {
    content += "Total frames captured: 0\n";
  }

  if (metrics.avgFrameDuration) {
    content += `Average frame duration: ${metrics.avgFrameDuration.toFixed(2)} ms\n`;
  }

  if (metrics.avgFps) {
    content += `Average FPS: ${metrics.avgFps.toFixed(1)}\n`;
  }

  if (metrics.jankyFrames) {
    content += `Janky frames (>16.67ms): ${metrics.jankyFrames} (${metrics.jankyFramesPercentage.toFixed(1)}%)\n`;
  }

  if (metrics.severeJankyFrames) {
    content += `Severe janky frames (>33.33ms): ${metrics.severeJankyFrames} (${metrics.severeJankyFramesPercentage.toFixed(1)}%)\n`;
  }

  await Deno.writeTextFile(metricsFile, content);
  console.log(`Metrics saved to ${metricsFile}`);
}

async function runPerformanceTests(config: Config) {
  console.log("Starting performance tests...");

  // Check if device is connected
  if (!await checkDeviceConnected()) {
    console.error("No Android device connected. Please connect a device and try again.");
    return;
  }

  for (let i = 1; i <= config.iterations; i++) {
    console.log(`\n=== Running test iteration ${i} ===`);

    // Clear app data
    if (!await clearAppData(config.appPackage)) {
      console.error("Failed to clear app data. Skipping iteration.");
      continue;
    }

    // Start tracing
    const traceStarted = await startTrace(config);
    if (!traceStarted) {
      console.error("Failed to start tracing. Skipping iteration.");
      continue;
    }

    // Launch app
    console.log("Launching app...");
    const launchOutput = await launchApp(config);
    console.log(launchOutput);

    // Wait for app to be fully loaded
    console.log(`Waiting for ${config.traceDuration} seconds...`);
    await new Promise(resolve => setTimeout(resolve, config.traceDuration * 1000));

    // Take a screenshot
    const screenshotPath = `${config.outputDir}/screenshot_${i}.png`;
    await takeScreenshot(screenshotPath);

    // Stop tracing
    const traceStopped = await stopTrace(config);
    if (!traceStopped) {
      console.error("Failed to stop tracing. Skipping iteration.");
      continue;
    }

    // Pull trace file
    const localTracePath = `${config.outputDir}/trace_iteration_${i}.perfetto`;
    const tracePulled = await pullTraceFile(config, localTracePath);

    if (!tracePulled) {
      console.error("Failed to pull trace file. Skipping iteration.");
      continue;
    }

    // Process trace data
    await processTraceData(config, localTracePath, i);
  }

  // Generate summary report
  await generateSummaryReport(config);

  console.log("\n===== Performance measurement completed =====");
  console.log(`Results saved to ${config.outputDir}`);
}

async function generateSummaryReport(config: Config): Promise<void> {
  console.log("Generating summary report...");
  const summaryPath = `${config.outputDir}/summary_report.txt`;

  let content = "===== Performance Summary Report =====\n";
  content += `Date: ${new Date().toISOString()}\n`;
  content += `App Package: ${config.appPackage}\n`;
  content += `App Activity: ${config.appActivity || `${config.appPackage}.MainActivity`}\n`;
  content += `Test Iterations: ${config.iterations}\n\n`;

  // Get device info
  const deviceInfo = await getDeviceInfo();
  content += `Device Model: ${deviceInfo.model || "Unknown"}\n`;
  content += `Android Version: ${deviceInfo.androidVersion || "Unknown"}\n\n`;

  // Add custom markers summary
  content += "== Custom Markers ==\n";
  for (const marker of config.customMarkers) {
    content += `- ${marker}: Searched for in trace files\n`;
  }

  await Deno.writeTextFile(summaryPath, content);
  console.log(`Summary report saved to ${summaryPath}`);
}

function printUsage() {
  console.log(`
Usage: deno run --allow-run --allow-read --allow-write --allow-env measure_performance.ts [options]

Options:
  -p, --package <package>       App package name
  -a, --activity <activity>     App activity name
  --iterations <number>         Number of test iterations
  --trace-duration <seconds>    Duration of trace capture in seconds
  -o, --output <directory>      Output directory for trace files
  -m, --markers <markers>       Custom markers (comma-separated)
  -e, --env <file>              Custom environment file
  -h, --help                    Show this help message
`);
}

async function loadEnvConfig(envPath: string = ".env"): Promise<Record<string, string>> {
  const config: Record<string, string> = {};

  try {
    const envExists = await Deno.stat(envPath).then(
      () => true,
      () => false
    );

    if (!envExists) {
      console.log(`No ${envPath} file found. Using defaults and command line arguments.`);
      return config;
    }

    const content = await Deno.readTextFile(envPath);
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.trim().startsWith("#") || line.trim() === "") {
        continue;
      }

      const match = line.match(/^\s*([^=]+)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        config[key] = value;
      }
    }

    console.log(`Loaded configuration from ${envPath}`);
  } catch (error) {
    console.error(`Error loading ${envPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return config;
}

async function loadMarkersConfig(configPath: string = "markers.json"): Promise<{
  customMarkers: string[];
  pairedMarkers: PairedMarker[]
}> {
  const defaultConfig = {
    customMarkers: ["TEST_EVENT_MANUAL", "app_js_initialized", "first_screen_mounted"],
    pairedMarkers: [
      { start: "trace_watchlist_tap_start", end: "trace_watchlist_fully_loaded_end", name: "watchlist_load" },
      { start: "trace_article_tap_start", end: "trace_article_fully_loaded_end", name: "article_load" }
    ]
  };

  try {
    const fileContent = await Deno.readTextFile(configPath);
    const config = JSON.parse(fileContent);
    return {
      customMarkers: config.customMarkers || defaultConfig.customMarkers,
      pairedMarkers: config.pairedMarkers || defaultConfig.pairedMarkers
    };
  } catch (error) {
    console.warn(`Warning: Could not load markers config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("Using default markers configuration");
    return defaultConfig;
  }
}

async function main() {
  // Load configuration from .env file if it exists
  const envConfig = await loadEnvConfig();

  // Parse command line arguments
  const args = parseArgs(Deno.args, {
    string: ["package", "activity", "output", "env", "markers", "iterations", "traceDuration"],
    boolean: ["help"],
    alias: {
      p: "package",
      a: "activity",
      o: "output",
      h: "help",
      e: "env",
      m: "markers",
    },
  });

  if (args.help) {
    printUsage();
    return;
  }

  // Set configuration values from .env or defaults
  const packageName = args.package || envConfig.APP_PACKAGE || PACKAGE_NAME;
  const appActivity = args.activity || envConfig.APP_ACTIVITY || "";
  const iterations = parseInt(args.iterations || envConfig.ITERATIONS || "3", 10);
  const traceDuration = parseInt(args.traceDuration || envConfig.TRACE_DURATION || "30", 10);
  const outputDir = args.output || envConfig.OUTPUT_DIR || "./performance_traces";
  const deviceTracePath = "/data/local/tmp/trace.txt"; // Use the same path as in the shell script
  const customMarkers = args.markers || envConfig.CUSTOM_MARKERS || "TEST_EVENT_MANUAL";

  // Parse paired markers from environment
  let pairedMarkers: PairedMarker[] = [];
  if (envConfig.PAIRED_MARKERS) {
    try {
      // Try to parse as JSON first
      pairedMarkers = JSON.parse(envConfig.PAIRED_MARKERS);
    } catch (e) {
      // If not valid JSON, try to parse as comma-separated list of "start:end:name" format
      pairedMarkers = envConfig.PAIRED_MARKERS.split(",").map(pair => {
        const [start, end, name] = pair.split(":");
        return { start, end, name: name || `${start}_to_${end}` };
      });
    }
  }

  const traceCategories = envConfig.TRACE_CATEGORIES || "sched,gfx,view,wm,am,app,input";

  // Create config object
  const config: Config = {
    appPackage: packageName,
    appActivity,
    iterations,
    traceDuration,
    outputDir,
    deviceTracePath,
    customMarkers: customMarkers.split(","),
    pairedMarkers,
    traceCategories,
  };

  // Create output directory if it doesn't exist
  try {
    await Deno.mkdir(config.outputDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error(`Failed to create output directory: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }

  // Print configuration
  console.log("===== React Native App Performance Measurement =====");
  console.log(`App Package: ${config.appPackage}`);
  console.log(`App Activity: ${config.appActivity || `${config.appPackage}.MainActivity`}`);
  console.log(`Running ${config.iterations} test iterations...`);
  console.log(`Output directory: ${config.outputDir}`);
  console.log(`Trace categories: ${config.traceCategories}`);
  console.log(`Custom markers: ${config.customMarkers.join(", ")}`);
  if (config.pairedMarkers.length > 0) {
    console.log(`Paired markers: ${config.pairedMarkers.map(pair => `${pair.start} to ${pair.end}`).join(", ")}`);
  }
  console.log("==================================================");

  // Run performance tests
  await runPerformanceTests(config);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${String(err)}`);
    }
    Deno.exit(1);
  }
}