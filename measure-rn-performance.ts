

import { intro, outro, spinner } from "npm:@clack/prompts";
import color from "npm:picocolors";

async function runCommand(cmd: string, args: string[]) {
  const p = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await p.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`[${cmd} ${args.join(" ")}] failed: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout);
}

interface Metric {
  name: string;
  value: number;
}

async function main() {
  intro(color.cyan("React Native Perf Measurement"));

  const s = spinner();
  s.start("Checking ADB connection...");
  try {
    await runCommand("adb", ["devices"]);
    s.stop(color.green("ADB found & working!"));
  } catch (err) {
    s.stop(color.red("Failed."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(color.red(`ADB not available: ${errorMessage}`));
    Deno.exit(1);
  }

  s.start("Installing APK onto emulator...");
  try {
    const apkPath = "../app/android/app/build/outputs/apk/debug/app-debug.apk";
    await runCommand("adb", ["install", "-r", apkPath]);
    s.stop(color.green("App installed!"));
  } catch (err) {
    s.stop(color.red("Failed to install APK."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(errorMessage);
    Deno.exit(1);
  }

  s.start("Launching app...");
  try {
    await runCommand("adb", [
      "shell",
      "am",
      "start",
      "-n",
      "com.myrnapp/.MainActivity",
    ]);
    s.stop(color.green("App launched!"));
  } catch (err) {
    s.stop(color.red("Failed to launch app."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(errorMessage);
    Deno.exit(1);
  }

  s.start("Capturing logs for performance metrics (10 seconds)...");
  const metrics: Metric[] = [];
  try {
    const adbProcess = new Deno.Command("adb", {
      args: ["logcat"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const deadline = Date.now() + 10_000;

    let done = false;

    while (!done && Date.now() < deadline) {
      const { value, done: readDone } = await adbProcess.stdout
        .pipeThrough(new TextDecoderStream())
        .getReader()
        .read();

      if (readDone || !value) {
        break;
      }

      const lines = value.split("\n");
      for (const line of lines) {
        const match = line.match(/\[Perf\]\s+(\w+)\s*:\s*([\d.]+)\s*ms/);
        if (match) {
          const metricName = match[1];
          const metricValue = parseFloat(match[2]);
          metrics.push({ name: metricName, value: metricValue });
        }

        const altMatch = line.match(/\[Perf\]\s+(\w+)\s*=\s*([\d.]+)/);
        if (altMatch) {
          const metricName = altMatch[1];
          const metricValue = parseFloat(altMatch[2]);
          metrics.push({ name: metricName, value: metricValue });
        }
      }
      done = false;
    }

    adbProcess.kill("SIGINT");
    s.stop(color.green("Logs captured."));
  } catch (err) {
    s.stop(color.red("Log capture failed."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(errorMessage);
  }

  console.log(color.yellow("\n--- Performance Metrics Collected ---"));
  for (const metric of metrics) {
    console.log(`${metric.name}: ${metric.value.toFixed(2)} ms`);
  }

  outro(color.bold(color.green("Done measuring!")));
}

if (import.meta.main) {
  await main();
}
