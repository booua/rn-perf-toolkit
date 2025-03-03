#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

// Configuration
interface Config {
  appPackage: string;
  appActivity: string;
  iterations: number;
  traceDuration: number;
  outputDir: string;
  customMarkers: string[];
  deviceTracePath: string;
  traceCategories: string[];
}
const PACKAGE_NAME = "com.example.app";
const config: Config = {
  appPackage: PACKAGE_NAME,
  appActivity: `${PACKAGE_NAME}.MainActivity`,
  iterations: 3,
  traceDuration: 30,
  outputDir: "./performance_traces",
  customMarkers: [
    "app_js_initialized",
    "first_screen_mounted",
    "TEST_EVENT_MANUAL",
    "home_feed_loaded",
    "splash_screen_dismissed",
    "onboarding_screen_shown",
  ],
  deviceTracePath: "/data/local/tmp/atrace_output.txt",
  traceCategories: ["gfx", "view", "wm", "am", "input", "sched", "app", "binder_driver"],
};

// Track successful runs
const successfulRuns: number[] = [];

// Run a command and return its output
async function runCommand(
  cmd: string,
  args: string[],
  options: Deno.CommandOptions = {}
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const defaultOptions: Deno.CommandOptions = {
    stdout: "piped",
    stderr: "piped",
  };

  const proc = new Deno.Command(cmd, { ...defaultOptions, ...options, args });
  const output = await proc.output();

  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// Check if a device is connected
async function checkDeviceConnected(): Promise<boolean> {
  const { success, stdout } = await runCommand("adb", ["devices"]);
  if (!success) return false;

  // Check if there's at least one device connected (excluding the header line)
  const lines = stdout.trim().split("\n");
  return lines.length > 1 && lines[1].includes("device");
}

// Clear app data
async function clearAppData(appPackage: string): Promise<boolean> {
  console.log("Clearing app data...");
  const { success } = await runCommand("adb", ["shell", "pm", "clear", appPackage]);
  return success;
}

// Start atrace
async function startTrace(config: Config): Promise<boolean> {
  console.log("Starting atrace...");
  const { success } = await runCommand("adb", [
    "shell",
    "atrace",
    "--async_start",
    "-t", config.traceDuration.toString(),
    "-a", config.appPackage,
    ...config.traceCategories
  ]);
  return success;
}

// Stop atrace and save output
async function stopTrace(config: Config): Promise<boolean> {
  console.log("Stopping atrace and collecting trace data...");
  const { success } = await runCommand("adb", [
    "shell",
    `atrace --async_stop > ${config.deviceTracePath}`
  ]);

  // Wait for trace to be written
  await new Promise(resolve => setTimeout(resolve, 2000));
  return success;
}

// Launch app and measure startup time
async function launchApp(config: Config): Promise<string> {
  console.log("Launching app...");
  const { stdout } = await runCommand("adb", [
    "shell",
    "am",
    "start-activity",
    "-W",
    "-n",
    `${config.appPackage}/${config.appActivity}`
  ]);
  return stdout;
}

// Take a screenshot
async function takeScreenshot(outputPath: string): Promise<boolean> {
  console.log("Taking screenshot...");
  const tempPath = "/sdcard/screen_temp.png";

  // Take screenshot on device
  const screencap = await runCommand("adb", ["shell", "screencap", "-p", tempPath]);
  if (!screencap.success) return false;

  // Pull screenshot to local machine
  const pull = await runCommand("adb", ["pull", tempPath, outputPath]);
  if (!pull.success) return false;

  // Clean up
  await runCommand("adb", ["shell", "rm", tempPath]);
  return true;
}

// Pull trace file from device
async function pullTraceFile(config: Config, localPath: string): Promise<boolean> {
  console.log("Pulling trace file...");
  const { success } = await runCommand("adb", ["pull", config.deviceTracePath, localPath]);
  return success;
}

// Get device info
async function getDeviceInfo(): Promise<Record<string, string>> {
  const info: Record<string, string> = {};

  const model = await runCommand("adb", ["shell", "getprop", "ro.product.model"]);
  if (model.success) info.model = model.stdout.trim();

  const androidVersion = await runCommand("adb", ["shell", "getprop", "ro.build.version.release"]);
  if (androidVersion.success) info.androidVersion = androidVersion.stdout.trim();

  return info;
}

// Process trace data to extract metrics
async function processTraceData(
  traceFile: string,
  metricsFile: string,
  config: Config
): Promise<Record<string, number>> {
  console.log(`Processing trace data from ${traceFile}...`);

  // Read trace file
  let traceContent: string;
  try {
    traceContent = await Deno.readTextFile(traceFile);
  } catch (err) {
    console.error(`Error reading trace file: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }

  // Initialize metrics object
  const metrics: Record<string, number> = {};

  // Extract app start timestamp
  const appStartMatch = traceContent.match(/([0-9.]+) ActivityManager: START.*?${config.appPackage}/);
  const appStartTimestamp = appStartMatch ? parseFloat(appStartMatch[1]) : 0;
  metrics.appStartTimestamp = appStartTimestamp;

  // Extract activity lifecycle events
  const createMatch = traceContent.match(/([0-9.]+).*performCreate.*${config.appPackage}/);
  const startMatch = traceContent.match(/([0-9.]+).*performStart.*${config.appPackage}/);
  const resumeMatch = traceContent.match(/([0-9.]+).*performResume.*${config.appPackage}/);
  const drawnMatch = traceContent.match(/([0-9.]+).*reportFullyDrawn.*${config.appPackage}/);

  if (createMatch) metrics.activityCreateTimestamp = parseFloat(createMatch[1]);
  if (startMatch) metrics.activityStartTimestamp = parseFloat(startMatch[1]);
  if (resumeMatch) metrics.activityResumeTimestamp = parseFloat(resumeMatch[1]);
  if (drawnMatch) metrics.activityDrawnTimestamp = parseFloat(drawnMatch[1]);

  // Extract custom markers
  for (const marker of config.customMarkers) {
    const markerMatch = traceContent.match(new RegExp(`([0-9.]+).*PerfettoTracer.*beginTrace.*${marker}`));
    if (markerMatch) {
      metrics[`${marker}Timestamp`] = parseFloat(markerMatch[1]);
    }
  }

  // Calculate time differences
  if (appStartTimestamp && metrics.activityCreateTimestamp) {
    metrics.timeToCreate = metrics.activityCreateTimestamp - appStartTimestamp;
  }

  if (metrics.activityCreateTimestamp && metrics.activityStartTimestamp) {
    metrics.createToStart = metrics.activityStartTimestamp - metrics.activityCreateTimestamp;
  }

  if (metrics.activityStartTimestamp && metrics.activityResumeTimestamp) {
    metrics.startToResume = metrics.activityResumeTimestamp - metrics.activityStartTimestamp;
  }

  if (appStartTimestamp && metrics.activityResumeTimestamp) {
    metrics.totalStartupTime = metrics.activityResumeTimestamp - appStartTimestamp;
  }

  if (appStartTimestamp && metrics.activityDrawnTimestamp) {
    metrics.timeToFullyDrawn = metrics.activityDrawnTimestamp - appStartTimestamp;
  }

  // Calculate time to custom markers
  for (const marker of config.customMarkers) {
    const markerTimestamp = metrics[`${marker}Timestamp`];
    if (appStartTimestamp && markerTimestamp) {
      metrics[`timeTo${marker.charAt(0).toUpperCase() + marker.slice(1)}`] =
        markerTimestamp - appStartTimestamp;
    }
  }

  // Calculate time between markers
  for (let i = 0; i < config.customMarkers.length; i++) {
    for (let j = i + 1; j < config.customMarkers.length; j++) {
      const marker1 = config.customMarkers[i];
      const marker2 = config.customMarkers[j];

      const timestamp1 = metrics[`${marker1}Timestamp`];
      const timestamp2 = metrics[`${marker2}Timestamp`];

      if (timestamp1 && timestamp2) {
        metrics[`${marker1}To${marker2.charAt(0).toUpperCase() + marker2.slice(1)}`] =
          timestamp2 - timestamp1;
      }
    }
  }

  // Extract frame data
  const frameMatches = traceContent.match(/[0-9.]+.*Choreographer.*doFrame/g) || [];
  metrics.totalFrames = frameMatches.length;

  if (frameMatches.length > 1) {
    // Extract timestamps
    const frameTimestamps = frameMatches.map(match => {
      const timestamp = match.match(/^([0-9.]+)/);
      return timestamp ? parseFloat(timestamp[1]) : 0;
    }).filter(ts => ts > 0);

    // Calculate frame durations
    const frameDurations: number[] = [];
    for (let i = 1; i < frameTimestamps.length; i++) {
      frameDurations.push((frameTimestamps[i] - frameTimestamps[i-1]) * 1000); // Convert to ms
    }

    if (frameDurations.length > 0) {
      // Calculate average frame duration and FPS
      const avgFrameDuration = frameDurations.reduce((sum, duration) => sum + duration, 0) / frameDurations.length;
      metrics.avgFrameDuration = avgFrameDuration;
      metrics.avgFps = 1000 / avgFrameDuration;

      // Count janky frames (> 16.67ms, which is less than 60fps)
      const jankyFrames = frameDurations.filter(duration => duration > 16.67).length;
      metrics.jankyFrames = jankyFrames;
      metrics.jankyFramesPercentage = (jankyFrames / frameDurations.length) * 100;

      // Count severe janky frames (> 33.33ms, which is less than 30fps)
      const severeJankyFrames = frameDurations.filter(duration => duration > 33.33).length;
      metrics.severeJankyFrames = severeJankyFrames;
      metrics.severeJankyFramesPercentage = (severeJankyFrames / frameDurations.length) * 100;
    }
  }

  // Write metrics to file
  await writeMetricsToFile(metricsFile, metrics, config);

  return metrics;
}

// Write metrics to file
async function writeMetricsToFile(
  metricsFile: string,
  metrics: Record<string, number>,
  config: Config
): Promise<void> {
  let content = "===== App Performance Metrics =====\n";
  content += `Date: ${new Date().toISOString()}\n\n`;

  // Android Activity Lifecycle Events
  content += "== Android Activity Lifecycle Events ==\n";
  if (metrics.appStartTimestamp) {
    content += `Activity start intent time: ${metrics.appStartTimestamp}\n`;
  } else {
    content += "Activity start intent time: Not found in trace\n";
  }

  if (metrics.activityCreateTimestamp) {
    content += `Activity performCreate time: ${metrics.activityCreateTimestamp}\n`;
  } else {
    content += "Activity performCreate time: Not found in trace\n";
  }

  if (metrics.activityStartTimestamp) {
    content += `Activity performStart time: ${metrics.activityStartTimestamp}\n`;
  } else {
    content += "Activity performStart time: Not found in trace\n";
  }

  if (metrics.activityResumeTimestamp) {
    content += `Activity performResume time: ${metrics.activityResumeTimestamp}\n`;
  } else {
    content += "Activity performResume time: Not found in trace\n";
  }

  if (metrics.activityDrawnTimestamp) {
    content += `Activity fully drawn time: ${metrics.activityDrawnTimestamp}\n`;
  } else {
    content += "Activity fully drawn time: Not found in trace\n";
  }

  content += "\n== Startup Performance Metrics ==\n";

  if (metrics.timeToCreate) {
    content += `Time from intent to performCreate: ${metrics.timeToCreate.toFixed(3)}s\n`;
  }

  if (metrics.createToStart) {
    content += `Time from performCreate to performStart: ${metrics.createToStart.toFixed(3)}s\n`;
  }

  if (metrics.startToResume) {
    content += `Time from performStart to performResume: ${metrics.startToResume.toFixed(3)}s\n`;
  }

  if (metrics.totalStartupTime) {
    content += `Total startup time (intent to performResume): ${metrics.totalStartupTime.toFixed(3)}s\n`;
  }

  if (metrics.timeToFullyDrawn) {
    content += `Total time to fully drawn: ${metrics.timeToFullyDrawn.toFixed(3)}s\n`;
  }

  content += "\n== Custom Performance Markers ==\n";

  // Report on all custom markers
  for (const marker of config.customMarkers) {
    const markerTimestamp = metrics[`${marker}Timestamp`];
    if (markerTimestamp) {
      content += `${marker} marker time: ${markerTimestamp}\n`;

      // Time from app start to this marker
      const timeToMarker = metrics[`timeTo${marker.charAt(0).toUpperCase() + marker.slice(1)}`];
      if (timeToMarker) {
        content += `Time from app start to ${marker}: ${timeToMarker.toFixed(3)}s\n`;
      }
    } else {
      content += `${marker} marker: Not found in trace\n`;
    }
  }

  content += "\n== Marker-to-Marker Timings ==\n";

  // Report on marker-to-marker timings
  for (let i = 0; i < config.customMarkers.length; i++) {
    for (let j = i + 1; j < config.customMarkers.length; j++) {
      const marker1 = config.customMarkers[i];
      const marker2 = config.customMarkers[j];

      const markerToMarker = metrics[`${marker1}To${marker2.charAt(0).toUpperCase() + marker2.slice(1)}`];

      if (markerToMarker) {
        content += `Time from ${marker1} to ${marker2}: ${markerToMarker.toFixed(3)}s\n`;
      }
    }
  }

  content += "\n== Frame Rendering Performance ==\n";

  if (metrics.totalFrames) {
    content += `Total frames: ${metrics.totalFrames}\n`;

    if (metrics.avgFrameDuration) {
      content += `Average frame duration: ${metrics.avgFrameDuration.toFixed(3)}ms\n`;
    }

    if (metrics.avgFps) {
      content += `Average FPS: ${metrics.avgFps.toFixed(1)}\n`;
    }

    if (metrics.jankyFrames !== undefined && metrics.jankyFramesPercentage !== undefined) {
      content += `Janky frames: ${metrics.jankyFrames}/${metrics.totalFrames} (${metrics.jankyFramesPercentage.toFixed(1)}%)\n`;
    }

    if (metrics.severeJankyFrames !== undefined && metrics.severeJankyFramesPercentage !== undefined) {
      content += `Severe janky frames: ${metrics.severeJankyFrames}/${metrics.totalFrames} (${metrics.severeJankyFramesPercentage.toFixed(1)}%)\n`;
    }
  } else {
    content += "No frame data found in trace\n";
  }

  await Deno.writeTextFile(metricsFile, content);
  console.log(`Metrics saved to ${metricsFile}`);
}

// Run a single test iteration
async function runTestIteration(iteration: number, config: Config): Promise<boolean> {
  console.log(`\n=== Running test iteration ${iteration} ===`);

  const traceOutput = join(config.outputDir, `trace_iteration_${iteration}.perfetto`);
  const metricsFile = join(config.outputDir, `metrics_${iteration}.txt`);
  const screenshotPath = join(config.outputDir, `screen_${iteration}.png`);

  // Stop app if running
  await runCommand("adb", ["shell", "am", "force-stop", config.appPackage]);

  // Clear app data for consistent testing
  if (!await clearAppData(config.appPackage)) {
    console.error("Failed to clear app data");
    return false;
  }

  // Wait for device to stabilize
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Start atrace
  if (!await startTrace(config)) {
    console.error("Failed to start trace");
    return false;
  }

  // Wait for trace to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Launch app
  const launchOutput = await launchApp(config);
  console.log(launchOutput);

  // Wait for app to fully initialize
  console.log("Waiting for app to fully initialize...");
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Take screenshot for verification
  if (!await takeScreenshot(screenshotPath)) {
    console.error("Failed to take screenshot");
  }

  // Stop app
  await runCommand("adb", ["shell", "am", "force-stop", config.appPackage]);

  // Stop trace and save output
  if (!await stopTrace(config)) {
    console.error("Failed to stop trace");
    return false;
  }

  // Pull trace file
  if (!await pullTraceFile(config, traceOutput)) {
    console.error("Failed to pull trace file");
    return false;
  }

  // Process trace data
  await processTraceData(traceOutput, metricsFile, config);

  return true;
}

// Generate summary report
async function generateSummaryReport(config: Config): Promise<void> {
  console.log("Generating summary report...");

  const summaryFile = join(config.outputDir, "summary_report.txt");
  const deviceInfo = await getDeviceInfo();

  let content = "======== Performance Test Summary ========\n";
  content += `Date: ${new Date().toISOString()}\n`;
  content += `Device: ${deviceInfo.model || "Unknown"}\n`;
  content += `Android version: ${deviceInfo.androidVersion || "Unknown"}\n\n`;

  // Collect metrics from all iterations
  const allMetrics: Record<string, number[]> = {};

  for (const iteration of successfulRuns) {
    const metricsFile = join(config.outputDir, `metrics_${iteration}.txt`);

    try {
      const metricsContent = await Deno.readTextFile(metricsFile);

      // Extract metrics using regex
      const extractMetric = (pattern: RegExp): number | null => {
        const match = metricsContent.match(pattern);
        return match ? parseFloat(match[1]) : null;
      };

      // Extract standard metrics
      const timeToCreate = extractMetric(/Time from intent to performCreate: ([0-9.]+)s/);
      if (timeToCreate) addMetric(allMetrics, "timeToCreate", timeToCreate);

      const createToStart = extractMetric(/Time from performCreate to performStart: ([0-9.]+)s/);
      if (createToStart) addMetric(allMetrics, "createToStart", createToStart);

      const startToResume = extractMetric(/Time from performStart to performResume: ([0-9.]+)s/);
      if (startToResume) addMetric(allMetrics, "startToResume", startToResume);

      const totalStartupTime = extractMetric(/Total startup time \(intent to performResume\): ([0-9.]+)s/);
      if (totalStartupTime) addMetric(allMetrics, "totalStartupTime", totalStartupTime);

      const timeToFullyDrawn = extractMetric(/Total time to fully drawn: ([0-9.]+)s/);
      if (timeToFullyDrawn) addMetric(allMetrics, "timeToFullyDrawn", timeToFullyDrawn);

      // Extract custom marker metrics
      for (const marker of config.customMarkers) {
        const timeToMarker = extractMetric(new RegExp(`Time from app start to ${marker}: ([0-9.]+)s`));
        if (timeToMarker) addMetric(allMetrics, `timeTo${marker}`, timeToMarker);
      }

      // Extract marker-to-marker timings
      for (let i = 0; i < config.customMarkers.length; i++) {
        for (let j = i + 1; j < config.customMarkers.length; j++) {
          const marker1 = config.customMarkers[i];
          const marker2 = config.customMarkers[j];

          const markerToMarker = extractMetric(new RegExp(`Time from ${marker1} to ${marker2}: ([0-9.]+)s`));
          if (markerToMarker) addMetric(allMetrics, `${marker1}To${marker2}`, markerToMarker);
        }
      }

      // Extract frame metrics
      const avgFrameDuration = extractMetric(/Average frame duration: ([0-9.]+)ms/);
      if (avgFrameDuration) addMetric(allMetrics, "avgFrameDuration", avgFrameDuration);

      const avgFps = extractMetric(/Average FPS: ([0-9.]+)/);
      if (avgFps) addMetric(allMetrics, "avgFps", avgFps);

      const jankyPercentage = extractMetric(/Janky frames: [0-9]+\/[0-9]+ \(([0-9.]+)%\)/);
      if (jankyPercentage) addMetric(allMetrics, "jankyPercentage", jankyPercentage);

      const severeJankyPercentage = extractMetric(/Severe janky frames: [0-9]+\/[0-9]+ \(([0-9.]+)%\)/);
      if (severeJankyPercentage) addMetric(allMetrics, "severeJankyPercentage", severeJankyPercentage);

    } catch (err) {
      console.error(`Error processing metrics file ${metricsFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Calculate averages and add to summary
  content += "App startup performance (averaged over successful runs):\n";
  addAverageToSummary(content, allMetrics, "timeToCreate", "Time from intent to performCreate");
  addAverageToSummary(content, allMetrics, "createToStart", "Time from performCreate to performStart");
  addAverageToSummary(content, allMetrics, "startToResume", "Time from performStart to performResume");
  addAverageToSummary(content, allMetrics, "totalStartupTime", "Total startup time (intent to performResume)");
  addAverageToSummary(content, allMetrics, "timeToFullyDrawn", "Total time to fully drawn");

  content += "\nCustom marker timings (averaged over successful runs):\n";
  for (const marker of config.customMarkers) {
    addAverageToSummary(content, allMetrics, `timeTo${marker}`, `Time from app start to ${marker}`);
  }

  content += "\nMarker-to-marker timings (averaged over successful runs):\n";
  for (let i = 0; i < config.customMarkers.length; i++) {
    for (let j = i + 1; j < config.customMarkers.length; j++) {
      const marker1 = config.customMarkers[i];
      const marker2 = config.customMarkers[j];
      addAverageToSummary(content, allMetrics, `${marker1}To${marker2}`, `Time from ${marker1} to ${marker2}`);
    }
  }

  content += "\nFrame rendering performance (averaged over successful runs):\n";
  addAverageToSummary(content, allMetrics, "avgFrameDuration", "Average frame duration", "ms");
  addAverageToSummary(content, allMetrics, "avgFps", "Average FPS");
  addAverageToSummary(content, allMetrics, "jankyPercentage", "Janky frames percentage", "%");
  addAverageToSummary(content, allMetrics, "severeJankyPercentage", "Severe jank percentage", "%");

  await Deno.writeTextFile(summaryFile, content);
  console.log(`Summary report saved to ${summaryFile}`);

  function addMetric(metrics: Record<string, number[]>, name: string, value: number): void {
    if (!metrics[name]) metrics[name] = [];
    metrics[name].push(value);
  }

  function addAverageToSummary(
    content: string,
    metrics: Record<string, number[]>,
    metricName: string,
    displayName: string,
    unit: string = "s"
  ): string {
    const values = metrics[metricName];
    if (values && values.length > 0) {
      const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
      content += `- ${displayName}: ${avg.toFixed(3)}${unit} (averaged over ${values.length} runs)\n`;
    } else {
      content += `- ${displayName}: No data available\n`;
    }
    return content;
  }
}

// Main function
async function main() {
  console.log("===== React Native App Performance Measurement =====");
  console.log(`App Package: ${config.appPackage}`);
  console.log(`Running ${config.iterations} test iterations...`);
  console.log(`Output directory: ${config.outputDir}`);
  console.log("==================================================");

  // Check if device is connected
  if (!await checkDeviceConnected()) {
    console.error("No device connected. Please connect a device and try again.");
    Deno.exit(1);
  }

  // Create output directory
  await ensureDir(config.outputDir);

  // Make sure atrace permissions are set correctly
  await runCommand("adb", ["shell", "echo", "1", ">", "/sys/kernel/debug/tracing/tracing_on"], { stderr: "null" });

  // Run test iterations
  for (let i = 1; i <= config.iterations; i++) {
    const success = await runTestIteration(i, config);
    if (success) {
      successfulRuns.push(i);
    }
  }

  // Generate summary report if we have any successful runs
  if (successfulRuns.length > 0) {
    await generateSummaryReport(config);
  }

  console.log(`\n===== Performance measurement completed =====`);
  console.log(`Successful runs: ${successfulRuns.length}/${config.iterations}`);
  console.log(`Results saved to ${config.outputDir}`);
}

// Run the main function
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