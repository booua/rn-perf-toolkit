#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write
/**
 * create-avds.ts
 *
 * A Deno script that:
 * 1. Reads avd_config.json
 * 2. Installs each unique system image package once (avoiding repeated "Installing..." logs)
 * 3. Creates each AVD (passing --tag/--abi if specified)
 * 4. Customizes config.ini with user-defined fields
 */

import { existsSync } from "https://deno.land/std@0.190.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.190.0/path/mod.ts";
import { intro, outro, spinner } from "npm:@clack/prompts";
import color from "npm:picocolors";

const CONFIG_FILE = "avd_config.json";
const installedPackages = new Set<string>(); // track installed system images

interface DeviceConfig {
  avd_name: string;
  package: string;
  device: string;
  tag?: string;
  abi?: string;
  ram?: string;
  internal_storage?: string;
  sd_card_size?: string;
  screen_resolution?: string;
  network_type?: string;
  signal_strength?: string;
  battery_level?: string;
  battery_health?: string;
}

interface Config {
  devices: DeviceConfig[];
}

const successfulCreations: string[] = [];

async function runCommand(cmd: string, args: string[]) {
  const proc = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`Error running "${cmd} ${args.join(" ")}":\n${stderr}`);
  }
  return new TextDecoder().decode(output.stdout);
}

function replaceOrAppend(
  content: string,
  pattern: RegExp,
  newLine: string,
): string {
  const lines = content.split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.push(newLine);
  }
  return lines.join("\n");
}

async function ensurePackageInstalled(pkg: string) {
  if (installedPackages.has(pkg)) {
    return;
  }

  const s = spinner();
  s.start(`Installing system image (if needed): ${pkg}...`);

  try {
    await runCommand("sdkmanager", ["--install", pkg]);
    installedPackages.add(pkg);
    s.stop(color.green("Done installing image!"));
  } catch (err) {
    s.stop(color.red("Failed."));
    throw err;
  }
}

async function createAvd(deviceConfig: DeviceConfig) {
  const {
    avd_name: AVD_NAME,
    package: PACKAGE,
    device: DEVICE,
    tag: TAG,
    abi: ABI,
    ram: RAM,
    internal_storage: INTERNAL_STORAGE,
    sd_card_size: SD_CARD_SIZE,
    screen_resolution: SCREEN_RESOLUTION,
    network_type: NETWORK_TYPE,
    signal_strength: SIGNAL_STRENGTH,
    battery_level: BATTERY_LEVEL,
    battery_health: BATTERY_HEALTH,
  } = deviceConfig;

  if (!AVD_NAME || !PACKAGE || !DEVICE) {
    throw new Error(`Missing required fields (avd_name, package, device).`);
  }

  await ensurePackageInstalled(PACKAGE);

  const avdArgs = [
    "create",
    "avd",
    "-n",
    AVD_NAME,
    "-k",
    PACKAGE,
    "-d",
    DEVICE,
    "--force",
  ];

  if (TAG && TAG !== "null") {
    avdArgs.push("--tag", TAG);
  }
  if (ABI && ABI !== "null") {
    avdArgs.push("--abi", ABI);
  }

  const s = spinner();
  s.start(`Creating AVD "${AVD_NAME}"...`);
  try {
    await runCommand("avdmanager", avdArgs);
    s.stop(color.green("Done creating AVD!"));
  } catch (err) {
    s.stop(color.red("Failed."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Error creating AVD "${AVD_NAME}":\n${errorMessage}`);
  }

  s.start(`Customizing AVD config for "${AVD_NAME}"...`);
  try {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
    if (!homeDir) {
      throw new Error("Unable to determine user home directory.");
    }

    const avdDir = path.join(homeDir, ".android", "avd", `${AVD_NAME}.avd`);
    const configPath = path.join(avdDir, "config.ini");
    if (!existsSync(configPath)) {
      throw new Error(`File not found: ${configPath}`);
    }

    let configContent = await Deno.readTextFile(configPath);

    if (RAM) {
      configContent = replaceOrAppend(
        configContent,
        /^hw\.ramSize=/,
        `hw.ramSize=${RAM}`,
      );
    }
    if (INTERNAL_STORAGE) {
      configContent = replaceOrAppend(
        configContent,
        /^disk\.dataPartition\.size=/,
        `disk.dataPartition.size=${INTERNAL_STORAGE}`,
      );
    }
    if (SD_CARD_SIZE) {
      configContent = replaceOrAppend(
        configContent,
        /^sdcard\.size=/,
        `sdcard.size=${SD_CARD_SIZE}`,
      );
    }
    if (SCREEN_RESOLUTION) {
      const [width, height] = SCREEN_RESOLUTION.split("x");
      if (width && height) {
        configContent = replaceOrAppend(
          configContent,
          /^hw\.lcd\.width=/,
          `hw.lcd.width=${width}`,
        );
        configContent = replaceOrAppend(
          configContent,
          /^hw\.lcd\.height=/,
          `hw.lcd.height=${height}`,
        );
      }
    }
    if (NETWORK_TYPE) {
      configContent = replaceOrAppend(
        configContent,
        /^hw\.network=/,
        `hw.network=${NETWORK_TYPE}`,
      );
    }
    if (SIGNAL_STRENGTH) {
      configContent = replaceOrAppend(
        configContent,
        /^hw\.network\.signalStrength=/,
        `hw.network.signalStrength=${SIGNAL_STRENGTH}`,
      );
    }
    if (BATTERY_LEVEL) {
      configContent = replaceOrAppend(
        configContent,
        /^battery\.level=/,
        `battery.level=${BATTERY_LEVEL}`,
      );
    }
    if (BATTERY_HEALTH) {
      configContent = replaceOrAppend(
        configContent,
        /^battery\.health=/,
        `battery.health=${BATTERY_HEALTH}`,
      );
    }

    await Deno.writeTextFile(configPath, configContent);
    s.stop(color.green("Done customizing AVD config!"));
  } catch (err) {
    s.stop(color.red("Failed."));
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Error customizing AVD config:\n${errorMessage}`);
  }
  successfulCreations.push(AVD_NAME);

}

async function main() {
  intro(color.cyan("Create AVD Script"));

  // 1. Check if avdmanager/sdkmanager are on PATH
  try {
    await runCommand("which", ["sdkmanager"]);
  } catch {
    console.error(color.red('Error: "sdkmanager" not found in PATH.'));
    Deno.exit(1);
  }
  try {
    await runCommand("which", ["avdmanager"]);
  } catch {
    console.error(color.red('Error: "avdmanager" not found in PATH.'));
    Deno.exit(1);
  }

  if (!existsSync(CONFIG_FILE)) {
    console.error(color.red(`No config file: ${CONFIG_FILE}`));
    Deno.exit(1);
  }
  let config: Config;

  try {
    const raw = await Deno.readTextFile(CONFIG_FILE);
    config = JSON.parse(raw);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(color.red(`Failed to parse ${CONFIG_FILE}: ${errorMessage}`));
    Deno.exit(1);
  }

  if (!config.devices || !Array.isArray(config.devices)) {
    console.error(
      color.red(`Missing or invalid "devices" array in ${CONFIG_FILE}.`),
    );
    Deno.exit(1);
  }
  const deviceCount = config.devices.length;
  console.log(color.bold(`Found ${deviceCount} device(s) in ${CONFIG_FILE}.`));

  for (let i = 0; i < deviceCount; i++) {
    const deviceCfg = config.devices[i];
    console.log(
      color.blue(
        `\nProcessing device ${i + 1} of ${deviceCount}: ${deviceCfg.avd_name}`,
      ),
    );
    try {
      await createAvd(deviceCfg);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        color.red(`Failed to create device ${i + 1}: ${errorMessage}`),
      );
      Deno.exit(1);
    }
  }

  if (successfulCreations.length > 0) {
    console.log(color.green("\nSuccessfully created AVDs:"));
    successfulCreations.forEach((name) => {
      console.log(color.green(`  ✓ ${name}`));
    });
  }

  outro(
    color.green(
      `Created ${successfulCreations.length}/${deviceCount} AVDs successfully!`,
    ),
  );
}

if (import.meta.main) {
  await main();
}
