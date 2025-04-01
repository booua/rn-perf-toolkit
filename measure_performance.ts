#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

import { parse as parseArgs } from "https://deno.land/std@0.224.0/flags/mod.ts";

const PACKAGE_NAME = "com.example.app";

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
  markersConfigPath: string;
  warmMode: boolean;
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
    console.error(
      `Failed to execute command: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
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
  const { success } = await runCommand("adb", [
    "shell",
    "pm",
    "clear",
    appPackage,
  ]);
  return success;
}

async function startTrace(config: Config): Promise<boolean> {
  console.log("Starting trace capture...");

  const { success, stderr } = await runCommand("adb", [
    "shell",
    `atrace --async_start -a ${config.appPackage} -b 16000 -c ${config.traceCategories}`,
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

  const { success, stderr } = await runCommand("adb", [
    "shell",
    `atrace --async_stop -o ${config.deviceTracePath}`,
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
  const activityName =
    config.appActivity || `${config.appPackage}.MainActivity`;
  const { success, stdout, stderr } = await runCommand("adb", [
    "shell",
    "am",
    "start-activity",
    "-W",
    `${config.appPackage}/${activityName}`,
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

  const screencap = await runCommand("adb", [
    "shell",
    "screencap",
    "-p",
    tempPath,
  ]);
  if (!screencap.success) return false;

  const pull = await runCommand("adb", ["pull", tempPath, outputPath]);
  if (!pull.success) return false;

  await runCommand("adb", ["shell", "rm", tempPath]);
  return true;
}

async function pullTraceFile(
  config: Config,
  localPath: string
): Promise<boolean> {
  console.log("Pulling trace file...");

  const { success, stderr } = await runCommand("adb", [
    "pull",
    config.deviceTracePath,
    localPath,
  ]);

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

  const modelResult = await runCommand("adb", [
    "shell",
    "getprop",
    "ro.product.model",
  ]);
  if (modelResult.success) {
    info.model = modelResult.stdout.trim();
  }

  const versionResult = await runCommand("adb", [
    "shell",
    "getprop",
    "ro.build.version.release",
  ]);
  if (versionResult.success) {
    info.androidVersion = versionResult.stdout.trim();
  }

  return info;
}

async function processTraceData(
  config: Config,
  tracePath: string,
  iteration: number
): Promise<void> {
  console.log(`Processing trace data from ${tracePath}...`);

  const metricsPath = `${config.outputDir}/metrics_${iteration}.txt`;
  const metrics: Record<string, number> = {};

  try {
    const traceContent = await Deno.readTextFile(tracePath);

    let appStartTimestamp = 0;
    const appStartPatterns = [
      // First try to find Startup trace
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:\\s+B\\|\\d+\\|Startup`
      ),
      // Then try APPLICATION_START
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*APPLICATION_START`
      ),
      // Fallback to other patterns
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*ActivityManager.*START.*?${config.appPackage}`
      ),
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*ActivityTaskManager.*START.*?${config.appPackage}`
      ),
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*Displayed.*?${config.appPackage}`
      ),
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*am_create_activity.*?${config.appPackage}`
      ),
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*am_on_resume_called.*?${config.appPackage}`
      ),
      new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*am_proc_start.*?${config.appPackage}`
      ),
      /([0-9.]+).*ActivityManager.*START.*?${config.appPackage}/,
      /([0-9.]+).*ActivityTaskManager.*START.*?${config.appPackage}/,
      /([0-9.]+).*ActivityManager.*Displayed.*?${config.appPackage}/,
      /([0-9.]+).*am_create_activity.*?${config.appPackage}/,
      /([0-9.]+).*am_on_resume_called.*?${config.appPackage}/,
      /([0-9.]+).*am_proc_start.*?${config.appPackage}/,
      /([0-9.]+).*am_create_task.*?${config.appPackage}/,
    ];

    for (const pattern of appStartPatterns) {
      const match = traceContent.match(pattern);
      if (match) {
        appStartTimestamp = parseFloat(match[1]);
        console.log(
          `Found app start timestamp: ${appStartTimestamp} using pattern: ${pattern}`
        );
        break;
      }
    }

    if (!appStartTimestamp) {
      const appFirstMentionPattern = new RegExp(
        `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+.*${config.appPackage}`
      );
      const firstMentionMatch = traceContent.match(appFirstMentionPattern);
      if (firstMentionMatch) {
        appStartTimestamp = parseFloat(firstMentionMatch[1]);
        console.log(
          `Using first mention of app package as start time: ${appStartTimestamp}`
        );
      }
    }

    if (!appStartTimestamp) {
      const firstTimestampMatch = traceContent.match(
        /\S+\s+\(\s*\d+\)\s+\[\d+\]\s+\.+\s+([0-9.]+):/
      );
      if (firstTimestampMatch) {
        appStartTimestamp = parseFloat(firstTimestampMatch[1]);
        console.log(
          `Using first timestamp in trace as app start: ${appStartTimestamp}`
        );
      }
    }

    metrics.appStartTimestamp = appStartTimestamp;

    if (!appStartTimestamp) {
      console.error(
        "Could not find app start timestamp in trace. Metrics will be incomplete."
      );
    }

    const createMatch = traceContent.match(
      /([0-9.]+).*performCreate.*?${config.appPackage}/
    );
    const startMatch = traceContent.match(
      /([0-9.]+).*performStart.*?${config.appPackage}/
    );
    const resumeMatch = traceContent.match(
      /([0-9.]+).*performResume.*?${config.appPackage}/
    );
    const drawnMatch = traceContent.match(
      /([0-9.]+).*reportFullyDrawn.*?${config.appPackage}/
    );

    if (createMatch)
      metrics.activityCreateTimestamp = parseFloat(createMatch[1]);
    if (startMatch) metrics.activityStartTimestamp = parseFloat(startMatch[1]);
    if (resumeMatch)
      metrics.activityResumeTimestamp = parseFloat(resumeMatch[1]);
    if (drawnMatch) metrics.activityDrawnTimestamp = parseFloat(drawnMatch[1]);

    for (const marker of config.customMarkers) {
      const patterns = [
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:\\s+\\w+\\|\\d+\\|${marker}`
        ),
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*${marker}`
        ),
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
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:\\s+\\w+\\|\\d+\\|${pair.start}`
        ),
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*${pair.start}`
        ),
        new RegExp(`([0-9.]+).*PerfettoTracer.*beginTrace.*${pair.start}`),
        new RegExp(`([0-9.]+).*PerfettoTracer.*${pair.start}`),
        new RegExp(`([0-9.]+).*${pair.start}`),
      ];

      const endPatterns = [
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:\\s+\\w+\\|\\d+\\|${pair.end}`
        ),
        new RegExp(
          `\\S+\\s+\\(\\s*\\d+\\)\\s+\\[\\d+\\]\\s+\\.+\\s+([0-9.]+):\\s+tracing_mark_write:.*${pair.end}`
        ),
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
          console.log(
            `Found start marker: ${pair.start} at time ${startTimestamp}`
          );
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
        console.log(
          `Duration for ${pair.name}: ${metrics[`${pair.name}Duration`].toFixed(
            3
          )}s`
        );
      }
    }

    if (appStartTimestamp) {
      if (metrics.activityCreateTimestamp) {
        metrics.timeToCreate =
          metrics.activityCreateTimestamp - appStartTimestamp;
      }
      if (metrics.activityStartTimestamp) {
        metrics.timeToStart =
          metrics.activityStartTimestamp - appStartTimestamp;
      }
      if (metrics.activityResumeTimestamp) {
        metrics.timeToResume =
          metrics.activityResumeTimestamp - appStartTimestamp;
      }
      if (metrics.activityDrawnTimestamp) {
        metrics.timeToFullyDrawn =
          metrics.activityDrawnTimestamp - appStartTimestamp;
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

    const normalizeTimestamp = (timestamp: number): number => {
      if (timestamp > 1000000) {
        return parseFloat((timestamp / 1000000).toFixed(3));
      }
      return timestamp;
    };

    if (metrics.appStartTimestamp) {
      metrics.appStartTimestamp = normalizeTimestamp(metrics.appStartTimestamp);
    }

    if (metrics.activityCreateTimestamp) {
      metrics.activityCreateTimestamp = normalizeTimestamp(
        metrics.activityCreateTimestamp
      );
    }

    if (metrics.activityStartTimestamp) {
      metrics.activityStartTimestamp = normalizeTimestamp(
        metrics.activityStartTimestamp
      );
    }

    if (metrics.activityResumeTimestamp) {
      metrics.activityResumeTimestamp = normalizeTimestamp(
        metrics.activityResumeTimestamp
      );
    }

    if (metrics.activityDrawnTimestamp) {
      metrics.activityDrawnTimestamp = normalizeTimestamp(
        metrics.activityDrawnTimestamp
      );
    }

    for (const marker of config.customMarkers) {
      const timestampKey = `${marker}Timestamp`;
      const relativeTimeKey = `timeTo${marker}`;

      if (metrics[timestampKey]) {
        metrics[timestampKey] = normalizeTimestamp(metrics[timestampKey]);
      }

      if (metrics[relativeTimeKey]) {
        metrics[relativeTimeKey] = parseFloat(
          metrics[relativeTimeKey].toFixed(3)
        );
      }
    }

    for (const pair of config.pairedMarkers) {
      const startTimestampKey = `${pair.start}Timestamp`;
      const endTimestampKey = `${pair.end}Timestamp`;
      const durationKey = `${pair.name}Duration`;
      const startRelativeKey = `timeTo${pair.start}`;
      const endRelativeKey = `timeTo${pair.end}`;

      if (metrics[startTimestampKey]) {
        metrics[startTimestampKey] = normalizeTimestamp(
          metrics[startTimestampKey]
        );
      }

      if (metrics[endTimestampKey]) {
        metrics[endTimestampKey] = normalizeTimestamp(metrics[endTimestampKey]);
      }

      if (metrics[durationKey]) {
        metrics[durationKey] = parseFloat(metrics[durationKey].toFixed(3));
      }

      if (metrics[startRelativeKey]) {
        metrics[startRelativeKey] = parseFloat(
          metrics[startRelativeKey].toFixed(3)
        );
      }

      if (metrics[endRelativeKey]) {
        metrics[endRelativeKey] = parseFloat(
          metrics[endRelativeKey].toFixed(3)
        );
      }
    }

    await writeMetricsToFile(metricsPath, metrics, config);
  } catch (error) {
    console.error(
      `Error processing trace data: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function writeMetricsToFile(
  metricsFile: string,
  metrics: Record<string, number>,
  config: Config
): Promise<void> {
  let content = "=== Performance Metrics ===\n";
  content += `App Package: ${config.appPackage}\n`;
  content += `Run Mode: ${config.warmMode ? "Warm" : "Cold"}\n`;
  content += `Date: ${new Date().toISOString()}\n\n`;

  if (metrics.appStartTimestamp) {
    content += `App Start Timestamp (t=0): ${metrics.appStartTimestamp.toFixed(
      3
    )} seconds (absolute time)\n\n`;
  }

  content += "== App Lifecycle Events ==\n";

  if (metrics.activityCreateTimestamp) {
    content += `Activity Create: ${metrics.activityCreateTimestamp.toFixed(
      3
    )} seconds (absolute time)\n`;
    if (metrics.timeToCreate) {
      content += `  - Time from app start: ${metrics.timeToCreate.toFixed(
        3
      )} seconds\n`;
    }
  }

  if (metrics.activityStartTimestamp) {
    content += `Activity Start: ${metrics.activityStartTimestamp.toFixed(
      3
    )} seconds (absolute time)\n`;
    if (metrics.timeToStart) {
      content += `  - Time from app start: ${metrics.timeToStart.toFixed(
        3
      )} seconds\n`;
    }
  }

  if (metrics.activityResumeTimestamp) {
    content += `Activity Resume: ${metrics.activityResumeTimestamp.toFixed(
      3
    )} seconds (absolute time)\n`;
    if (metrics.timeToResume) {
      content += `  - Time from app start: ${metrics.timeToResume.toFixed(
        3
      )} seconds\n`;
    }
  }

  if (metrics.activityDrawnTimestamp) {
    content += `Activity Fully Drawn: ${metrics.activityDrawnTimestamp.toFixed(
      3
    )} seconds (absolute time)\n`;
    if (metrics.timeToFullyDrawn) {
      content += `  - Time from app start: ${metrics.timeToFullyDrawn.toFixed(
        3
      )} seconds\n`;
    }
  }

  content += "\n== Custom Markers ==\n";

  for (const marker of config.customMarkers) {
    const markerTimestamp = metrics[`${marker}Timestamp`];
    const timeToMarker = metrics[`timeTo${marker}`];

    if (markerTimestamp) {
      content += `${marker}:\n`;
      content += `  - Absolute time: ${markerTimestamp.toFixed(3)} seconds\n`;

      if (timeToMarker) {
        content += `  - Time from app start (t=0): ${timeToMarker.toFixed(
          3
        )} seconds\n`;
      }
    } else {
      content += `${marker}: Not found in trace\n`;
    }
  }

  if (config.pairedMarkers.length > 0) {
    content += "\n== Paired Markers (Start/End) ==\n";
    for (const pair of config.pairedMarkers) {
      const startTimestamp = metrics[`${pair.start}Timestamp`];
      const endTimestamp = metrics[`${pair.end}Timestamp`];
      const duration = metrics[`${pair.name}Duration`];
      const timeToStart = metrics[`timeTo${pair.start}`];
      const timeToEnd = metrics[`timeTo${pair.end}`];

      content += `=== ${pair.name} ===\n`;

      if (startTimestamp) {
        content += `${pair.start}:\n`;
        content += `  - Absolute time: ${startTimestamp.toFixed(3)} seconds\n`;

        if (timeToStart !== undefined) {
          content += `  - Time from app start (t=0): ${timeToStart.toFixed(
            3
          )} seconds\n`;
        }
      } else {
        content += `${pair.start}: Not found in trace\n`;
      }

      if (endTimestamp) {
        content += `${pair.end}:\n`;
        content += `  - Absolute time: ${endTimestamp.toFixed(3)} seconds\n`;

        if (timeToEnd !== undefined) {
          content += `  - Time from app start (t=0): ${timeToEnd.toFixed(
            3
          )} seconds\n`;
        }
      } else {
        content += `${pair.end}: Not found in trace\n`;
      }

      if (startTimestamp && endTimestamp) {
        const calculatedDuration = endTimestamp - startTimestamp;
        content += `Duration of ${pair.name}: ${calculatedDuration.toFixed(
          3
        )} seconds\n`;
      } else {
        content += `Duration of ${pair.name}: Could not be calculated\n`;
      }

      content += "\n";
    }
  }

  await Deno.writeTextFile(metricsFile, content);
  console.log(`Metrics saved to ${metricsFile}`);
}

async function runPerformanceTests(config: Config) {
  console.log("Starting performance tests...");

  if (!(await checkDeviceConnected())) {
    console.error(
      "No Android device connected. Please connect a device and try again."
    );
    return;
  }

  for (let i = 1; i <= config.iterations; i++) {
    console.log(`\n=== Running test iteration ${i} ===`);

    if (!config.warmMode) {
      if (!(await clearAppData(config.appPackage))) {
        console.error("Failed to clear app data. Skipping iteration.");
        continue;
      }
    } else {
      console.log("Warm mode: Skipping app data clearing");
    }

    const traceStarted = await startTrace(config);
    if (!traceStarted) {
      console.error("Failed to start tracing. Skipping iteration.");
      continue;
    }

    console.log("Launching app...");
    const launchOutput = await launchApp(config);
    console.log(launchOutput);

    console.log(`Waiting for ${config.traceDuration} seconds...`);
    await new Promise((resolve) =>
      setTimeout(resolve, config.traceDuration * 1000)
    );

    const screenshotPath = `${config.outputDir}/screenshot_${i}.png`;
    await takeScreenshot(screenshotPath);

    const traceStopped = await stopTrace(config);
    if (!traceStopped) {
      console.error("Failed to stop tracing. Skipping iteration.");
      continue;
    }

    const localTracePath = `${config.outputDir}/trace_iteration_${i}.perfetto`;
    const tracePulled = await pullTraceFile(config, localTracePath);

    if (!tracePulled) {
      console.error("Failed to pull trace file. Skipping iteration.");
      continue;
    }

    await processTraceData(config, localTracePath, i);
  }

  await generateSummaryReport(config);

  console.log("\n===== Performance measurement completed =====");
  console.log(`Results saved to ${config.outputDir}`);
}

async function generateSummaryReport(config: Config): Promise<void> {
  console.log("Generating summary report...");
  const summaryPath = `${config.outputDir}/summary_report.txt`;

  const allMetrics: Record<string, number[]> = {};
  const metricsFiles: string[] = [];

  for (let i = 1; i <= config.iterations; i++) {
    metricsFiles.push(`${config.outputDir}/metrics_${i}.txt`);
  }

  for (const file of metricsFiles) {
    try {
      const content = await Deno.readTextFile(file);

      for (const marker of config.customMarkers) {
        const markerTimeMatch = content.match(
          new RegExp(`${marker}:\\s*\\n\\s*- Absolute time: ([0-9.]+) seconds`)
        );
        const timeFromStartMatch = content.match(
          new RegExp(
            `${marker}:.*\\n.*\\n\\s*- Time from app start \\(t=0\\): ([0-9.]+) seconds`
          )
        );

        if (markerTimeMatch) {
          const markerTime = parseFloat(markerTimeMatch[1]);
          if (!allMetrics[`${marker}_absolute`]) {
            allMetrics[`${marker}_absolute`] = [];
          }
          allMetrics[`${marker}_absolute`].push(markerTime);
        }

        if (timeFromStartMatch) {
          const timeFromStart = parseFloat(timeFromStartMatch[1]);
          if (!allMetrics[`${marker}_relative`]) {
            allMetrics[`${marker}_relative`] = [];
          }
          allMetrics[`${marker}_relative`].push(timeFromStart);
        }
      }

      for (const pair of config.pairedMarkers) {
        const startTimeMatch = content.match(
          new RegExp(
            `${pair.start}:\\s*\\n\\s*- Absolute time: ([0-9.]+) seconds`
          )
        );
        const startFromAppMatch = content.match(
          new RegExp(
            `${pair.start}:.*\\n.*\\n\\s*- Time from app start \\(t=0\\): ([0-9.]+) seconds`
          )
        );

        if (startTimeMatch) {
          const startTime = parseFloat(startTimeMatch[1]);
          if (!allMetrics[`${pair.start}_absolute`]) {
            allMetrics[`${pair.start}_absolute`] = [];
          }
          allMetrics[`${pair.start}_absolute`].push(startTime);
        }

        if (startFromAppMatch) {
          const startFromApp = parseFloat(startFromAppMatch[1]);
          if (!allMetrics[`${pair.start}_relative`]) {
            allMetrics[`${pair.start}_relative`] = [];
          }
          allMetrics[`${pair.start}_relative`].push(startFromApp);
        }

        const endTimeMatch = content.match(
          new RegExp(
            `${pair.end}:\\s*\\n\\s*- Absolute time: ([0-9.]+) seconds`
          )
        );
        const endFromAppMatch = content.match(
          new RegExp(
            `${pair.end}:.*\\n.*\\n\\s*- Time from app start \\(t=0\\): ([0-9.]+) seconds`
          )
        );

        if (endTimeMatch) {
          const endTime = parseFloat(endTimeMatch[1]);
          if (!allMetrics[`${pair.end}_absolute`]) {
            allMetrics[`${pair.end}_absolute`] = [];
          }
          allMetrics[`${pair.end}_absolute`].push(endTime);
        }

        if (endFromAppMatch) {
          const endFromApp = parseFloat(endFromAppMatch[1]);
          if (!allMetrics[`${pair.end}_relative`]) {
            allMetrics[`${pair.end}_relative`] = [];
          }
          allMetrics[`${pair.end}_relative`].push(endFromApp);
        }

        const durationMatch = content.match(
          new RegExp(`Duration of ${pair.name}: ([0-9.]+) seconds`)
        );
        if (durationMatch) {
          const duration = parseFloat(durationMatch[1]);
          if (!allMetrics[`${pair.name}_duration`]) {
            allMetrics[`${pair.name}_duration`] = [];
          }
          allMetrics[`${pair.name}_duration`].push(duration);
        }
      }

      const createMatch = content.match(/Activity Create: ([0-9.]+) seconds/);
      const startMatch = content.match(/Activity Start: ([0-9.]+) seconds/);
      const resumeMatch = content.match(/Activity Resume: ([0-9.]+) seconds/);
      const drawnMatch = content.match(
        /Activity Fully Drawn: ([0-9.]+) seconds/
      );

      if (createMatch) {
        if (!allMetrics.activity_create) allMetrics.activity_create = [];
        allMetrics.activity_create.push(parseFloat(createMatch[1]));
      }

      if (startMatch) {
        if (!allMetrics.activity_start) allMetrics.activity_start = [];
        allMetrics.activity_start.push(parseFloat(startMatch[1]));
      }

      if (resumeMatch) {
        if (!allMetrics.activity_resume) allMetrics.activity_resume = [];
        allMetrics.activity_resume.push(parseFloat(resumeMatch[1]));
      }

      if (drawnMatch) {
        if (!allMetrics.activity_drawn) allMetrics.activity_drawn = [];
        allMetrics.activity_drawn.push(parseFloat(drawnMatch[1]));
      }
    } catch (error) {
      console.error(
        `Error reading metrics file ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let content = "===== Performance Summary Report =====\n";
  content += `Date: ${new Date().toISOString()}\n`;
  content += `App Package: ${config.appPackage}\n`;
  content += `App Activity: ${
    config.appActivity || `${config.appPackage}.MainActivity`
  }\n`;
  content += `Test Iterations: ${config.iterations}\n`;
  content += `Run Mode: ${config.warmMode ? "Warm" : "Cold"}\n\n`;

  const deviceInfo = await getDeviceInfo();
  content += `Device Model: ${deviceInfo.model || "Unknown"}\n`;
  content += `Android Version: ${deviceInfo.androidVersion || "Unknown"}\n\n`;

  function calculateStats(values: number[]): {
    min: number;
    max: number;
    avg: number;
    median: number;
  } {
    if (!values || values.length === 0) {
      return { min: 0, max: 0, avg: 0, median: 0 };
    }

    const sortedValues = [...values].sort((a, b) => a - b);
    const min = sortedValues[0];
    const max = sortedValues[sortedValues.length - 1];
    const avg =
      sortedValues.reduce((sum, val) => sum + val, 0) / sortedValues.length;

    let median: number;
    const mid = Math.floor(sortedValues.length / 2);
    if (sortedValues.length % 2 === 0) {
      median = (sortedValues[mid - 1] + sortedValues[mid]) / 2;
    } else {
      median = sortedValues[mid];
    }

    return { min, max, avg, median };
  }

  content += "== App Lifecycle Events ==\n";

  if (allMetrics.activity_create && allMetrics.activity_create.length > 0) {
    const stats = calculateStats(allMetrics.activity_create);
    content += "Activity Create:\n";
    content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
    content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
    content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
    content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
  }

  if (allMetrics.activity_start && allMetrics.activity_start.length > 0) {
    const stats = calculateStats(allMetrics.activity_start);
    content += "Activity Start:\n";
    content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
    content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
    content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
    content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
  }

  if (allMetrics.activity_resume && allMetrics.activity_resume.length > 0) {
    const stats = calculateStats(allMetrics.activity_resume);
    content += "Activity Resume:\n";
    content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
    content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
    content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
    content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
  }

  if (allMetrics.activity_drawn && allMetrics.activity_drawn.length > 0) {
    const stats = calculateStats(allMetrics.activity_drawn);
    content += "Activity Fully Drawn:\n";
    content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
    content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
    content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
    content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
  }

  content += "== Custom Markers ==\n";
  for (const marker of config.customMarkers) {
    content += `=== ${marker} ===\n`;

    if (
      allMetrics[`${marker}_absolute`] &&
      allMetrics[`${marker}_absolute`].length > 0
    ) {
      const stats = calculateStats(allMetrics[`${marker}_absolute`]);
      content += "Absolute Time:\n";
      content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
      content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
      content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
      content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
    } else {
      content += "Absolute Time: Not found in traces\n\n";
    }

    if (
      allMetrics[`${marker}_relative`] &&
      allMetrics[`${marker}_relative`].length > 0
    ) {
      const stats = calculateStats(allMetrics[`${marker}_relative`]);
      content += "Time from App Start (t=0):\n";
      content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
      content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
      content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
      content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
    } else {
      content += "Time from App Start: Not found in traces\n\n";
    }
  }

  if (config.pairedMarkers.length > 0) {
    content += "== Paired Markers ==\n";
    for (const pair of config.pairedMarkers) {
      content += `=== ${pair.name} ===\n`;

      content += `${pair.start}:\n`;
      if (
        allMetrics[`${pair.start}_absolute`] &&
        allMetrics[`${pair.start}_absolute`].length > 0
      ) {
        const stats = calculateStats(allMetrics[`${pair.start}_absolute`]);
        content += "  Absolute Time:\n";
        content += `    - Min: ${stats.min.toFixed(3)} seconds\n`;
        content += `    - Max: ${stats.max.toFixed(3)} seconds\n`;
        content += `    - Avg: ${stats.avg.toFixed(3)} seconds\n`;
        content += `    - Median: ${stats.median.toFixed(3)} seconds\n\n`;
      } else {
        content += "  Absolute Time: Not found in traces\n\n";
      }

      if (
        allMetrics[`${pair.start}_relative`] &&
        allMetrics[`${pair.start}_relative`].length > 0
      ) {
        const stats = calculateStats(allMetrics[`${pair.start}_relative`]);
        content += "  Time from App Start (t=0):\n";
        content += `    - Min: ${stats.min.toFixed(3)} seconds\n`;
        content += `    - Max: ${stats.max.toFixed(3)} seconds\n`;
        content += `    - Avg: ${stats.avg.toFixed(3)} seconds\n`;
        content += `    - Median: ${stats.median.toFixed(3)} seconds\n\n`;
      } else {
        content += "  Time from App Start: Not found in traces\n\n";
      }

      content += `${pair.end}:\n`;
      if (
        allMetrics[`${pair.end}_absolute`] &&
        allMetrics[`${pair.end}_absolute`].length > 0
      ) {
        const stats = calculateStats(allMetrics[`${pair.end}_absolute`]);
        content += "  Absolute Time:\n";
        content += `    - Min: ${stats.min.toFixed(3)} seconds\n`;
        content += `    - Max: ${stats.max.toFixed(3)} seconds\n`;
        content += `    - Avg: ${stats.avg.toFixed(3)} seconds\n`;
        content += `    - Median: ${stats.median.toFixed(3)} seconds\n\n`;
      } else {
        content += "  Absolute Time: Not found in traces\n\n";
      }

      if (
        allMetrics[`${pair.end}_relative`] &&
        allMetrics[`${pair.end}_relative`].length > 0
      ) {
        const stats = calculateStats(allMetrics[`${pair.end}_relative`]);
        content += "  Time from App Start (t=0):\n";
        content += `    - Min: ${stats.min.toFixed(3)} seconds\n`;
        content += `    - Max: ${stats.max.toFixed(3)} seconds\n`;
        content += `    - Avg: ${stats.avg.toFixed(3)} seconds\n`;
        content += `    - Median: ${stats.median.toFixed(3)} seconds\n\n`;
      } else {
        content += "  Time from App Start: Not found in traces\n\n";
      }

      content += `Duration (${pair.end} - ${pair.start}):\n`;
      if (
        allMetrics[`${pair.name}_duration`] &&
        allMetrics[`${pair.name}_duration`].length > 0
      ) {
        const stats = calculateStats(allMetrics[`${pair.name}_duration`]);
        content += `  - Min: ${stats.min.toFixed(3)} seconds\n`;
        content += `  - Max: ${stats.max.toFixed(3)} seconds\n`;
        content += `  - Avg: ${stats.avg.toFixed(3)} seconds\n`;
        content += `  - Median: ${stats.median.toFixed(3)} seconds\n\n`;
      } else {
        content += "  Duration: Could not be calculated\n\n";
      }
    }
  }

  content += "== Raw Data by Iteration ==\n";
  for (const key in allMetrics) {
    if (allMetrics[key] && allMetrics[key].length > 0) {
      content += `${key}:\n`;
      for (let i = 0; i < allMetrics[key].length; i++) {
        content += `  - Iteration ${i + 1}: ${allMetrics[key][i].toFixed(
          3
        )} seconds\n`;
      }
      content += "\n";
    }
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
  -m, --markers-config <file>   Path to markers configuration JSON file
  -w, --warm                    Run in warm mode (don't clear app data)
  -e, --env <file>              Custom environment file
  -h, --help                    Show this help message
`);
}

async function loadEnvConfig(
  envPath: string = ".env"
): Promise<Record<string, string>> {
  const config: Record<string, string> = {};

  try {
    const envExists = await Deno.stat(envPath).then(
      () => true,
      () => false
    );

    if (!envExists) {
      console.log(
        `No ${envPath} file found. Using defaults and command line arguments.`
      );
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
    console.error(
      `Error loading ${envPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return config;
}

async function loadMarkersConfig(configPath: string = "markers.json"): Promise<{
  customMarkers: string[];
  pairedMarkers: PairedMarker[];
}> {
  const defaultConfig = {
    customMarkers: [
      "TEST_EVENT_MANUAL",
      "app_js_initialized",
      "first_screen_mounted",
    ],
    pairedMarkers: [
      {
        start: "trace_watchlist_tap_start",
        end: "trace_watchlist_fully_loaded_end",
        name: "watchlist_load",
      },
      {
        start: "trace_article_tap_start",
        end: "trace_article_fully_loaded_end",
        name: "article_load",
      },
    ],
  };

  try {
    const fileContent = await Deno.readTextFile(configPath);
    const config = JSON.parse(fileContent);
    return {
      customMarkers: config.customMarkers || defaultConfig.customMarkers,
      pairedMarkers: config.pairedMarkers || defaultConfig.pairedMarkers,
    };
  } catch (error) {
    console.warn(
      `Warning: Could not load markers config from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    console.warn("Using default markers configuration");
    return defaultConfig;
  }
}

async function main() {
  const envConfig = await loadEnvConfig();

  const args = parseArgs(Deno.args, {
    string: [
      "package",
      "activity",
      "output",
      "env",
      "markers-config",
      "iterations",
      "traceDuration",
    ],
    boolean: ["help", "warm"],
    alias: {
      p: "package",
      a: "activity",
      o: "output",
      h: "help",
      e: "env",
      m: "markers-config",
      w: "warm",
    },
  });

  if (args.help) {
    printUsage();
    return;
  }

  const packageName = args.package || envConfig.APP_PACKAGE || PACKAGE_NAME;
  const appActivity = args.activity || envConfig.APP_ACTIVITY || "";
  const iterations = parseInt(
    args.iterations || envConfig.ITERATIONS || "3",
    10
  );
  const traceDuration = parseInt(
    args.traceDuration || envConfig.TRACE_DURATION || "30",
    10
  );
  const outputDir =
    args.output || envConfig.OUTPUT_DIR || "./performance_traces";
  const deviceTracePath = "/data/local/tmp/trace.txt";
  const markersConfigPath =
    args["markers-config"] || envConfig.MARKERS_CONFIG || "markers.json";
  const traceCategories =
    envConfig.TRACE_CATEGORIES || "sched,gfx,view,wm,am,app,input";
  const warmMode = args.warm || false;

  const markersConfig = await loadMarkersConfig(markersConfigPath);

  const config: Config = {
    appPackage: packageName,
    appActivity,
    iterations,
    traceDuration,
    outputDir,
    deviceTracePath,
    customMarkers: markersConfig.customMarkers,
    pairedMarkers: markersConfig.pairedMarkers,
    traceCategories,
    markersConfigPath,
    warmMode,
  };

  try {
    await Deno.mkdir(config.outputDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error(
        `Failed to create output directory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
  }

  console.log("===== React Native App Performance Measurement =====");
  console.log(`App Package: ${config.appPackage}`);
  console.log(
    `App Activity: ${config.appActivity || `${config.appPackage}.MainActivity`}`
  );
  console.log(`Running ${config.iterations} test iterations...`);
  console.log(`Run Mode: ${config.warmMode ? "Warm" : "Cold"}`);
  console.log(`Output directory: ${config.outputDir}`);
  console.log(`Trace categories: ${config.traceCategories}`);
  console.log(`Markers config: ${config.markersConfigPath}`);
  console.log(`Custom markers: ${config.customMarkers.join(", ")}`);
  if (config.pairedMarkers.length > 0) {
    console.log(
      `Paired markers: ${config.pairedMarkers
        .map((pair) => `${pair.start} to ${pair.end}`)
        .join(", ")}`
    );
  }
  console.log("==================================================");

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
