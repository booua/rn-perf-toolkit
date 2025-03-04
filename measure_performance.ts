#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

interface Config {
  appPackage: string;
  appActivity: string;
  iterations: number;
  traceDuration: number;
  outputDir: string;
  customMarkers: string[];
  pairedMarkers: { start: string; end: string; name: string }[];
  deviceTracePath: string;
  traceCategories: string[];
}

const PACKAGE_NAME = "com.example.app";

async function runCommand(
  cmd: string,
  args: string[],
  options: Deno.CommandOptions = {}
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const defaultOptions: Deno.CommandOptions = {
    stdout: "piped",
    stderr: "piped",
  };

  try {
    const proc = new Deno.Command(cmd, { ...defaultOptions, ...options, args });
    const output = await proc.output();

    return {
      success: output.success,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (error) {
    console.error(`Error executing command '${cmd}': ${error instanceof Error ? error.message : String(error)}`);
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
  console.log("Starting atrace...");

  await runCommand("adb", ["shell", "echo", "1", ">", "/sys/kernel/debug/tracing/tracing_on"]);

  const { success, stderr } = await runCommand("adb", [
    "shell",
    `atrace --async_start -b 4000 -t ${config.traceDuration} -a ${config.appPackage} ${config.traceCategories.join(" ")}`
  ]);

  if (!success) {
    console.error(`Failed to start trace: ${stderr}`);
    return false;
  }

  return true;
}

async function stopTrace(config: Config): Promise<boolean> {
  console.log("Stopping atrace and collecting trace data...");

  const stopResult = await runCommand("adb", ["shell", "atrace", "--async_stop"]);
  if (!stopResult.success) {
    console.error(`Failed to stop trace: ${stopResult.stderr}`);
    return false;
  }

  console.log("Trace stopped, saving output to file...");

  try {
    const dumpResult = await runCommand("adb", ["shell", `atrace --async_dump > "${config.deviceTracePath}"`]);

    if (!dumpResult.success) {
      console.error(`Failed to save trace output: ${dumpResult.stderr}`);

      console.log("Trying alternative approach to save trace...");
      const altDumpResult = await runCommand("adb", ["shell", "atrace --async_dump > /data/local/tmp/atrace_output.txt"]);

      if (!altDumpResult.success) {
        console.error(`Alternative approach also failed: ${altDumpResult.stderr}`);

        console.log("Trying final approach to save trace...");
        const finalDumpResult = await runCommand("adb", ["shell", "atrace", "--async_dump"]);

        if (finalDumpResult.success) {
          console.log("Got trace data, saving to device...");
          const saveResult = await runCommand("adb", ["shell", `echo '${finalDumpResult.stdout}' > "${config.deviceTracePath}"`]);

          if (!saveResult.success) {
            console.error(`Failed to save trace data: ${saveResult.stderr}`);
            return false;
          }
        } else {
          console.error(`Final approach also failed: ${finalDumpResult.stderr}`);
          return false;
        }
      } else {
        config.deviceTracePath = "/data/local/tmp/atrace_output.txt";
      }
    }

    console.log("Waiting for trace to be written...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    return true;
  } catch (error) {
    console.error(`Error in stopTrace: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

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

  const { success, stderr } = await runCommand("adb", ["pull", config.deviceTracePath, localPath]);

  if (!success) {
    console.error(`Failed to pull trace file: ${stderr}`);

    console.log("Checking if trace file exists on device...");
    const checkResult = await runCommand("adb", ["shell", `ls -l "${config.deviceTracePath}"`]);

    if (!checkResult.success || !checkResult.stdout.trim()) {
      console.error("Trace file does not exist on device");

      console.log("Looking for alternative trace files...");
      const findResult = await runCommand("adb", ["shell", "ls -l /data/local/tmp/atrace*"]);

      if (findResult.success && findResult.stdout.trim()) {
        console.log(`Found alternative trace files: ${findResult.stdout}`);

        const altFile = findResult.stdout.trim().split("\n")[0].split(" ").pop();
        if (altFile) {
          console.log(`Trying to pull alternative trace file: ${altFile}`);
          const altPull = await runCommand("adb", ["pull", altFile, localPath]);
          return altPull.success;
        }
      }

      return false;
    }

    console.log("Trace file exists but pull failed, trying with different options...");
    const altPull = await runCommand("adb", ["pull", config.deviceTracePath, localPath, "-a"]);
    return altPull.success;
  }

  return true;
}
async function getDeviceInfo(): Promise<Record<string, string>> {
  const info: Record<string, string> = {};

  const model = await runCommand("adb", ["shell", "getprop", "ro.product.model"]);
  if (model.success) info.model = model.stdout.trim();

  const androidVersion = await runCommand("adb", ["shell", "getprop", "ro.build.version.release"]);
  if (androidVersion.success) info.androidVersion = androidVersion.stdout.trim();

  return info;
}
async function processTraceData(
  traceFile: string,
  metricsFile: string,
  config: Config
): Promise<Record<string, number>> {
  console.log(`Processing trace data from ${traceFile}...`);

  let traceContent: string;
  try {
    traceContent = await Deno.readTextFile(traceFile);
  } catch (err) {
    console.error(`Error reading trace file: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }

  const metrics: Record<string, number> = {};

  const appStartMatch = traceContent.match(/([0-9.]+).*ActivityManager.*START.*?${config.appPackage}/);
  const appStartTimestamp = appStartMatch ? parseFloat(appStartMatch[1]) : 0;
  metrics.appStartTimestamp = appStartTimestamp;

  if (!appStartTimestamp) {
    console.error("Could not find app start timestamp in trace. Metrics will be incomplete.");
  }

  const createMatch = traceContent.match(/([0-9.]+).*performCreate.*?${config.appPackage}/);
  const startMatch = traceContent.match(/([0-9.]+).*performStart.*?${config.appPackage}/);
  const resumeMatch = traceContent.match(/([0-9.]+).*performResume.*?${config.appPackage}/);
  const drawnMatch = traceContent.match(/([0-9.]+).*reportFullyDrawn.*?${config.appPackage}/);

  if (createMatch) metrics.activityCreateTimestamp = parseFloat(createMatch[1]);
  if (startMatch) metrics.activityStartTimestamp = parseFloat(startMatch[1]);
  if (resumeMatch) metrics.activityResumeTimestamp = parseFloat(resumeMatch[1]);
  if (drawnMatch) metrics.activityDrawnTimestamp = parseFloat(drawnMatch[1]);

  for (const marker of config.customMarkers) {
    const patterns = [
      new RegExp(`([0-9.]+).*PerfettoTracer.*beginTrace.*${marker}`),
      new RegExp(`([0-9.]+).*PerfettoTracer.*${marker}`),
      new RegExp(`([0-9.]+).*beginTrace.*${marker}`),
      new RegExp(`([0-9.]+).*${marker}.*begin`),
      new RegExp(`([0-9.]+).*begin.*${marker}`),
      new RegExp(`([0-9.]+).*TEST_EVENT_MANUAL`),
      new RegExp(`([0-9.]+).*test_event_manual`),
      new RegExp(`([0-9.]+).*${marker}`),
    ];

    for (const pattern of patterns) {
      const markerMatch = traceContent.match(pattern);
      if (markerMatch) {
        metrics[`${marker}Timestamp`] = parseFloat(markerMatch[1]);
        console.log(`Found marker: ${marker} at time ${markerMatch[1]}`);
        break;
      }
    }
  }

  for (const pair of config.pairedMarkers) {
    const startPatterns = [
      new RegExp(`([0-9.]+).*PerfettoTracer.*beginTrace.*${pair.start}`),
      new RegExp(`([0-9.]+).*PerfettoTracer.*${pair.start}`),
      new RegExp(`([0-9.]+).*${pair.start}`),
    ];

    const endPatterns = [
      new RegExp(`([0-9.]+).*PerfettoTracer.*beginTrace.*${pair.end}`),
      new RegExp(`([0-9.]+).*PerfettoTracer.*${pair.end}`),
      new RegExp(`([0-9.]+).*${pair.end}`),
    ];

    let startTimestamp = 0;
    let endTimestamp = 0;

    for (const pattern of startPatterns) {
      const match = traceContent.match(pattern);
      if (match) {
        startTimestamp = parseFloat(match[1]);
        metrics[`${pair.start}Timestamp`] = startTimestamp;
        console.log(`Found start marker: ${pair.start} at time ${startTimestamp}`);
        break;
      }
    }

    for (const pattern of endPatterns) {
      const match = traceContent.match(pattern);
      if (match) {
        endTimestamp = parseFloat(match[1]);
        metrics[`${pair.end}Timestamp`] = endTimestamp;
        console.log(`Found end marker: ${pair.end} at time ${endTimestamp}`);
        break;
      }
    }

    if (startTimestamp && endTimestamp) {
      metrics[`${pair.name}Duration`] = endTimestamp - startTimestamp;
      console.log(`Duration for ${pair.name}: ${metrics[`${pair.name}Duration`].toFixed(3)}s`);
    }
  }

  for (const marker of config.customMarkers) {
    if (!metrics[`${marker}Timestamp`]) {
      console.log(`Warning: Marker '${marker}' not found in trace`);
    }
  }

  for (const pair of config.pairedMarkers) {
    if (!metrics[`${pair.start}Timestamp`]) {
      console.log(`Warning: Start marker '${pair.start}' not found in trace`);
    }
    if (!metrics[`${pair.end}Timestamp`]) {
      console.log(`Warning: End marker '${pair.end}' not found in trace`);
    }
  }

  if (appStartTimestamp) {
    if (metrics.activityCreateTimestamp) {
      metrics.timeToCreate = metrics.activityCreateTimestamp - appStartTimestamp;
    }
    if (metrics.activityStartTimestamp) {
      metrics.timeToStart = metrics.activityStartTimestamp - appStartTimestamp;
    }
    if (metrics.activityResumeTimestamp) {
      metrics.timeToResume = metrics.activityResumeTimestamp - appStartTimestamp;
    }
    if (metrics.activityDrawnTimestamp) {
      metrics.timeToFullyDrawn = metrics.activityDrawnTimestamp - appStartTimestamp;
    }

    for (const marker of config.customMarkers) {
      const markerTimestamp = metrics[`${marker}Timestamp`];
      if (markerTimestamp) {
        metrics[`timeTo${marker}`] = markerTimestamp - appStartTimestamp;
      }
    }

    for (const pair of config.pairedMarkers) {
      const startTimestamp = metrics[`${pair.start}Timestamp`];
      const endTimestamp = metrics[`${pair.end}Timestamp`];

      if (startTimestamp) {
        metrics[`timeTo${pair.start}`] = startTimestamp - appStartTimestamp;
      }

      if (endTimestamp) {
        metrics[`timeTo${pair.end}`] = endTimestamp - appStartTimestamp;
      }
    }
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

  await writeMetricsToFile(metricsFile, metrics, config);

  return metrics;
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
async function runTestIteration(iteration: number, config: Config): Promise<boolean> {
  console.log(`\n=== Running test iteration ${iteration} ===`);

  const traceOutput = join(config.outputDir, `trace_iteration_${iteration}.perfetto`);
  const metricsFile = join(config.outputDir, `metrics_${iteration}.txt`);
  const screenshotPath = join(config.outputDir, `screen_${iteration}.png`);

  await runCommand("adb", ["shell", "am", "force-stop", config.appPackage]);

  if (!await clearAppData(config.appPackage)) {
    console.error("Failed to clear app data");
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 2000));

  if (!await startTrace(config)) {
    console.error("Failed to start trace");
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 2000));

  const launchOutput = await launchApp(config);
  console.log(launchOutput);

  console.log("Waiting for app to fully initialize and capture custom markers...");
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.log("App should be fully initialized now, custom markers should be captured");

  if (!await takeScreenshot(screenshotPath)) {
    console.error("Failed to take screenshot");
  }

  await runCommand("adb", ["shell", "am", "force-stop", config.appPackage]);

  if (!await stopTrace(config)) {
    console.error("Failed to stop trace");
    return false;
  }

  if (!await pullTraceFile(config, traceOutput)) {
    console.error("Failed to pull trace file");
    return false;
  }

  await processTraceData(traceOutput, metricsFile, config);

  return true;
}
async function generateSummaryReport(config: Config): Promise<void> {
  console.log("Generating summary report...");
  const summaryFile = join(config.outputDir, "summary_report.txt");
  const allMetrics: Record<string, number[]> = {};

  function addMetric(metrics: Record<string, number[]>, name: string, value: number): void {
    if (!metrics[name]) metrics[name] = [];
    metrics[name].push(value);
  }

  function addAverageToSummary(
    content: string,
    metrics: Record<string, number[]>,
    metricName: string,
    displayName: string,
    unit: string = "seconds"
  ): string {
    const values = metrics[metricName];
    if (values && values.length > 0) {
      const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
      content += `- ${displayName}: ${avg.toFixed(3)} ${unit} (averaged over ${values.length} runs)\n`;
    } else {
      content += `- ${displayName}: No data available\n`;
    }
    return content;
  }

  const dirEntries = await Deno.readDir(config.outputDir);
  for await (const file of dirEntries) {
    if (file.name.startsWith("metrics_") && file.name.endsWith(".txt")) {
      const filePath = join(config.outputDir, file.name);
      const fileContent = await Deno.readTextFile(filePath);
      const lines = fileContent.split("\n");

      for (const line of lines) {
        const extractMetric = (pattern: RegExp): number | null => {
          const match = line.match(pattern);
          return match ? parseFloat(match[1]) : null;
        };

        const timeToCreate = extractMetric(/Time from intent to performCreate: ([0-9.]+) seconds/);
        if (timeToCreate) addMetric(allMetrics, "timeToCreate", timeToCreate);

        const timeToStart = extractMetric(/Time from intent to performStart: ([0-9.]+) seconds/);
        if (timeToStart) addMetric(allMetrics, "timeToStart", timeToStart);

        const timeToResume = extractMetric(/Time from intent to performResume: ([0-9.]+) seconds/);
        if (timeToResume) addMetric(allMetrics, "timeToResume", timeToResume);

        const timeToFullyDrawn = extractMetric(/Total time to fully drawn: ([0-9.]+) seconds/);
        if (timeToFullyDrawn) addMetric(allMetrics, "timeToFullyDrawn", timeToFullyDrawn);

        for (const marker of config.customMarkers) {
          const timeToMarker = extractMetric(new RegExp(`Time from app start to ${marker}: ([0-9.]+) seconds`));
          if (timeToMarker) addMetric(allMetrics, `timeTo${marker}`, timeToMarker);
        }

        for (const pair of config.pairedMarkers) {
          const timeToStart = extractMetric(new RegExp(`Time from app start to ${pair.start}: ([0-9.]+) seconds`));
          if (timeToStart) addMetric(allMetrics, `timeTo${pair.start}`, timeToStart);

          const timeToEnd = extractMetric(new RegExp(`Time from app start to ${pair.end}: ([0-9.]+) seconds`));
          if (timeToEnd) addMetric(allMetrics, `timeTo${pair.end}`, timeToEnd);

          const duration = extractMetric(new RegExp(`Duration of ${pair.name}: ([0-9.]+) seconds`));
          if (duration) addMetric(allMetrics, `${pair.name}Duration`, duration);
        }

        const avgFrameDuration = extractMetric(/Average frame duration: ([0-9.]+) ms/);
        if (avgFrameDuration) addMetric(allMetrics, "avgFrameDuration", avgFrameDuration);

        const avgFps = extractMetric(/Average FPS: ([0-9.]+)/);
        if (avgFps) addMetric(allMetrics, "avgFps", avgFps);

        const jankyPercentage = extractMetric(/Janky frames \(>16.67ms\): \d+ \(([0-9.]+)%\)/);
        if (jankyPercentage) addMetric(allMetrics, "jankyPercentage", jankyPercentage);

        const severeJankyPercentage = extractMetric(/Severe janky frames \(>33.33ms\): \d+ \(([0-9.]+)%\)/);
        if (severeJankyPercentage) addMetric(allMetrics, "severeJankyPercentage", severeJankyPercentage);
      }
    }
  }

  let content = "===== Performance Summary Report =====\n";
  content += `Date: ${new Date().toISOString()}\n`;
  content += `Device: ${(await getDeviceInfo()).model || "Unknown"}\n`;
  content += `App Package: ${config.appPackage}\n`;
  content += `Test Iterations: ${config.iterations}\n\n`;

  content += "== App Startup Performance ==\n";
  content += "App startup performance (averaged over successful runs):\n";
  addAverageToSummary(content, allMetrics, "timeToCreate", "Time from intent to performCreate");
  addAverageToSummary(content, allMetrics, "timeToStart", "Time from intent to performStart");
  addAverageToSummary(content, allMetrics, "timeToResume", "Time from intent to performResume");
  addAverageToSummary(content, allMetrics, "timeToFullyDrawn", "Total time to fully drawn");

  content += "\n== Custom Marker Performance ==\n";
  for (const marker of config.customMarkers) {
    addAverageToSummary(content, allMetrics, `timeTo${marker}`, `Time from app start to ${marker}`);
  }

  if (config.pairedMarkers.length > 0) {
    content += "\n== Paired Marker Performance ==\n";
    for (const pair of config.pairedMarkers) {
      content += `=== ${pair.name} ===\n`;
      addAverageToSummary(content, allMetrics, `timeTo${pair.start}`, `Time from app start to ${pair.start}`);
      addAverageToSummary(content, allMetrics, `timeTo${pair.end}`, `Time from app start to ${pair.end}`);
      addAverageToSummary(content, allMetrics, `${pair.name}Duration`, `Duration of ${pair.name}`);
      content += "\n";
    }
  }

  content += "== Frame Rendering Performance ==\n";
  addAverageToSummary(content, allMetrics, "avgFrameDuration", "Average frame duration", "ms");
  addAverageToSummary(content, allMetrics, "avgFps", "Average FPS", "fps");
  addAverageToSummary(content, allMetrics, "jankyPercentage", "Janky frames percentage", "%");
  addAverageToSummary(content, allMetrics, "severeJankyPercentage", "Severe janky frames percentage", "%");

  await Deno.writeTextFile(summaryFile, content);
  console.log(`Summary report saved to ${summaryFile}`);
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
  pairedMarkers: { start: string; end: string; name: string }[]
}> {
  const defaultConfig = {
    customMarkers: ["TEST_EVENT_MANUAL", "app_js_initialized", "first_screen_mounted"],
    pairedMarkers: []
  };

  try {
    const configExists = await Deno.stat(configPath).then(
      () => true,
      () => false
    );

    if (!configExists) {
      console.log(`No ${configPath} file found. Using default markers.`);
      return defaultConfig;
    }

    const content = await Deno.readTextFile(configPath);
    const markersConfig = JSON.parse(content);

    console.log(`Loaded markers configuration from ${configPath}`);
    return {
      customMarkers: markersConfig.customMarkers || defaultConfig.customMarkers,
      pairedMarkers: markersConfig.pairedMarkers || defaultConfig.pairedMarkers
    };
  } catch (error) {
    console.error(`Error loading ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    return defaultConfig;
  }
}
async function main() {
  console.log("===== React Native Performance Measurement Tool =====");

  const envConfig = await loadEnvConfig();

  const args = Deno.args;
  let packageName = envConfig.APP_PACKAGE || PACKAGE_NAME;
  let appActivity = envConfig.APP_ACTIVITY || "";
  let iterations = envConfig.ITERATIONS ? parseInt(envConfig.ITERATIONS, 10) : 3;
  let traceDuration = envConfig.TRACE_DURATION ? parseInt(envConfig.TRACE_DURATION, 10) : 30;
  let outputDir = envConfig.OUTPUT_DIR || "./performance_traces";
  let deviceTracePath = envConfig.DEVICE_TRACE_PATH || "/data/local/tmp/atrace_output.txt";
  let markersConfigPath = envConfig.MARKERS_CONFIG || "markers.json";

  const markersConfig = await loadMarkersConfig(markersConfigPath);
  let customMarkers = markersConfig.customMarkers;
  let pairedMarkers = markersConfig.pairedMarkers;

  let traceCategories = ["gfx", "view", "wm", "am", "input", "sched", "app"];
  if (envConfig.TRACE_CATEGORIES) {
    traceCategories = envConfig.TRACE_CATEGORIES.split(",").map(category => category.trim());
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--package" && i + 1 < args.length) {
      packageName = args[++i];
    } else if (args[i] === "--activity" && i + 1 < args.length) {
      appActivity = args[++i];
    } else if (args[i] === "--iterations" && i + 1 < args.length) {
      iterations = parseInt(args[++i], 10);
    } else if (args[i] === "--trace-duration" && i + 1 < args.length) {
      traceDuration = parseInt(args[++i], 10);
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (args[i] === "--marker" && i + 1 < args.length) {
      customMarkers.push(args[++i]);
    } else if (args[i] === "--paired-marker" && i + 3 < args.length) {
      pairedMarkers.push({
        start: args[++i],
        end: args[++i],
        name: args[++i]
      });
    } else if (args[i] === "--markers-config" && i + 1 < args.length) {
      const customMarkersPath = args[++i];
      const customMarkersConfig = await loadMarkersConfig(customMarkersPath);
      customMarkers = [...customMarkers, ...customMarkersConfig.customMarkers];
      pairedMarkers = [...pairedMarkers, ...customMarkersConfig.pairedMarkers];
    } else if (args[i] === "--env" && i + 1 < args.length) {
      const customEnvPath = args[++i];
      const customEnvConfig = await loadEnvConfig(customEnvPath);

      if (customEnvConfig.APP_PACKAGE) packageName = customEnvConfig.APP_PACKAGE;
      if (customEnvConfig.APP_ACTIVITY) appActivity = customEnvConfig.APP_ACTIVITY;
      if (customEnvConfig.ITERATIONS) iterations = parseInt(customEnvConfig.ITERATIONS, 10);
      if (customEnvConfig.TRACE_DURATION) traceDuration = parseInt(customEnvConfig.TRACE_DURATION, 10);
      if (customEnvConfig.OUTPUT_DIR) outputDir = customEnvConfig.OUTPUT_DIR;
      if (customEnvConfig.DEVICE_TRACE_PATH) deviceTracePath = customEnvConfig.DEVICE_TRACE_PATH;

      if (customEnvConfig.MARKERS_CONFIG) {
        const customMarkersConfig = await loadMarkersConfig(customEnvConfig.MARKERS_CONFIG);
        customMarkers = [...customMarkers, ...customMarkersConfig.customMarkers];
        pairedMarkers = [...pairedMarkers, ...customMarkersConfig.pairedMarkers];
      }

      if (customEnvConfig.TRACE_CATEGORIES) {
        traceCategories = customEnvConfig.TRACE_CATEGORIES.split(",").map(cat => cat.trim());
      }
    }
  }

  if (!appActivity) {
    appActivity = `${packageName}.MainActivity`;
  }

  const config: Config = {
    appPackage: packageName,
    appActivity,
    iterations,
    traceDuration,
    outputDir,
    customMarkers: customMarkers.length > 0 ? customMarkers : ["TEST_EVENT_MANUAL", "app_js_initialized", "first_screen_mounted"],
    pairedMarkers: pairedMarkers.length > 0 ? pairedMarkers : [
      { start: "trace_watchlist_tap_start", end: "trace_watchlist_fully_loaded_end", name: "watchlist_load" },
      { start: "trace_article_tap_start", end: "trace_article_fully_loaded_end", name: "article_load" }
    ],
    deviceTracePath,
    traceCategories
  };

  console.log(`App Package: ${config.appPackage}`);
  console.log(`App Activity: ${config.appActivity}`);
  console.log(`Iterations: ${config.iterations}`);
  console.log(`Trace Duration: ${config.traceDuration} seconds`);
  console.log(`Output Directory: ${config.outputDir}`);
  console.log(`Custom Markers: ${config.customMarkers.join(", ")}`);
  console.log("Paired Markers:");
  for (const pair of config.pairedMarkers) {
    console.log(`  - ${pair.name}: ${pair.start} → ${pair.end}`);
  }
  console.log(`Trace Categories: ${config.traceCategories.join(", ")}`);
  console.log("=================================================");

  if (!await checkDeviceConnected()) {
    console.error("No Android device connected. Please connect a device and try again.");
    Deno.exit(1);
  }

  await ensureDir(config.outputDir);

  await runCommand("adb", ["shell", "echo", "1", ">", "/sys/kernel/debug/tracing/tracing_on"], { stderr: "null" });

  const successfulRuns: number[] = [];

  for (let i = 1; i <= config.iterations; i++) {
    const success = await runTestIteration(i, config);
    if (success) {
      successfulRuns.push(i);
    }
  }

  if (successfulRuns.length > 0) {
    await generateSummaryReport(config);
  }

  console.log(`\n===== Performance measurement completed =====`);
  console.log(`Successful runs: ${successfulRuns.length}/${config.iterations}`);
  console.log(`Results saved to ${config.outputDir}`);

  console.log("\nUsage Tips:");
  console.log("1. To add custom markers in your React Native app, use the PerfettoTracer API:");
  console.log("   - For JavaScript: PerfettoTracer.beginTrace('YOUR_MARKER_NAME')");
  console.log("   - For paired markers: Use start/end pairs like 'trace_screen_start' and 'trace_screen_end'");
  console.log("2. All times are measured from app launch (t=0)");
  console.log("3. View detailed metrics in the individual run files and summary in summary_report.txt");
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