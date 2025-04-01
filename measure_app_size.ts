#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

declare const Deno: {
  Command: new (
    cmd: string,
    options: { args: string[]; stdout: "piped"; stderr: "piped" | "null" }
  ) => {
    output(): Promise<{
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
      code: number;
    }>;
  };
  makeTempDir(): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, data: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  readDir(
    path: string
  ): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>;
  stat(
    path: string
  ): Promise<{ size: number; isFile: boolean; isDirectory: boolean }>;
  open(path: string): Promise<{
    read(buffer: Uint8Array): Promise<number | null>;
    close(): void;
  }>;
  args: string[];
  exit(code: number): never;
  errors: {
    AlreadyExists: new () => Error;
  };
};

interface ImportMeta {
  main: boolean;
  url: string;
  resolve(specifier: string): string;
}

// @deno-types="https://deno.land/x/types/deno.d.ts"

import { parse as parseArgs } from "https://deno.land/std@0.224.0/flags/mod.ts";

const DEFAULT_PACKAGE_NAME = "app.example.com";

interface Config {
  appPackage: string;
  outputDir: string;
  verbose: boolean;
  searchForHermes: boolean;
  deepSearch: boolean;
  analyzeLoaders: boolean;
  detectEncryption: boolean;
  buildType: "development" | "production";
}

interface BundleInfo {
  size: number;
  path: string;
  type: "js" | "hbc" | "bundle" | "loader" | "unknown";
  isEncrypted?: boolean;
  isLoader?: boolean;
}

interface NativeLibInfo {
  size: number;
  path: string;
  architecture: string;
  type: "hermes" | "react" | "other";
}

interface AppSizeMetrics {
  installedAppSize: number;
  downloadSize: number;
  bundleSize?: number;
  hermesSize?: number;
  bundleFiles?: Record<string, BundleInfo>;
  resourceSize?: number;
  nativeLibrariesSize?: number;
  reactNativeLibsSize?: number;
  componentsBreakdown?: Record<string, number>;
  architectureBreakdown?: Record<string, number>;
  bundleLoadingMechanism?: {
    type:
      | "direct"
      | "custom"
      | "encrypted"
      | "split"
      | "unknown"
      | "development";
    loaderFiles?: string[];
    encryptedFiles?: string[];
  };
  hermesRuntime?: {
    present: boolean;
    version?: string;
    architectures: string[];
    totalSize: number;
  };
  timestamp: string;
  permissionDenied?: boolean;
  appPaths?: {
    dataDir?: string;
    codePath?: string;
    resourcePath?: string;
  };
  isDevelopmentBuild?: boolean;
}

async function runCommand(
  cmd: string,
  args: string[],
  options: { stderr?: "piped" | "null"; sudo?: boolean } = {}
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const finalCmd = options.sudo && !cmd.includes("adb") ? "sudo" : cmd;
  const finalArgs =
    options.sudo && !cmd.includes("adb") ? [cmd, ...args] : args;

  try {
    const process = new Deno.Command(finalCmd, {
      args: finalArgs,
      stdout: "piped",
      stderr: options.stderr === "null" ? "null" : "piped",
    });

    const output = await process.output();
    const textDecoder = new TextDecoder();
    return {
      success: output.success,
      stdout: textDecoder.decode(output.stdout),
      stderr: textDecoder.decode(output.stderr),
    };
  } catch (error) {
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

async function getAppPaths(
  packageName: string
): Promise<AppSizeMetrics["appPaths"]> {
  const { success, stdout } = await runCommand("adb", [
    "shell",
    "dumpsys",
    "package",
    packageName,
    "|",
    "grep",
    "-E",
    "dataDir|codePath|resourcePath",
  ]);

  if (!success) return {};

  const paths: AppSizeMetrics["appPaths"] = {};
  const matches = {
    dataDir: /dataDir=([^\s]+)/,
    codePath: /codePath=([^\s]+)/,
    resourcePath: /resourcePath=([^\s]+)/,
  };

  Object.entries(matches).forEach(([key, regex]) => {
    const match = stdout.match(regex);
    if (match?.[1]) {
      paths[key as keyof typeof paths] = match[1];
    }
  });

  return paths;
}

async function getInstalledAppSize(
  config: Config,
  metrics: AppSizeMetrics
): Promise<void> {
  const methods = [
    async () => {
      // Try to get APK path and size first
      const { success, stdout } = await runCommand("adb", [
        "shell",
        "pm",
        "path",
        config.appPackage,
      ]);
      if (success && stdout) {
        const apkPath = stdout.trim().replace("package:", "");
        if (apkPath) {
          const sizeResult = await runCommand("adb", [
            "shell",
            "ls",
            "-l",
            apkPath,
          ]);
          if (sizeResult.success) {
            const match = sizeResult.stdout.match(
              /\s(\d+)\s+\d{4}-\d{2}-\d{2}/
            );
            if (match && match[1]) {
              return parseInt(match[1], 10);
            }
          }
        }
      }
      return 0;
    },
    async () => {
      // Try to get app data size using dumpsys
      const paths = (await getAppPaths(config.appPackage)) || {};
      metrics.appPaths = paths;

      if (paths && paths.dataDir) {
        const { success, stdout } = await runCommand("adb", [
          "shell",
          "du",
          "-s",
          paths.dataDir,
        ]);
        if (success) {
          const size = parseInt(stdout.trim().split(/\s+/)[0], 10);
          if (!isNaN(size)) {
            return size * 1024; // Convert from KB to bytes
          }
        }
      }
      return 0;
    },
    async () => {
      // Try dumpsys package info
      const { success, stdout } = await runCommand("adb", [
        "shell",
        "dumpsys",
        "package",
        config.appPackage,
      ]);
      if (success && stdout) {
        const sizeMatch = stdout.match(/codeSize=(\d+)/);
        if (sizeMatch && sizeMatch[1]) {
          return parseInt(sizeMatch[1], 10);
        }
      }
      return 0;
    },
  ];

  for (const method of methods) {
    const size = await method();
    if (size > 0) {
      metrics.installedAppSize = size;
      return;
    }
  }

  metrics.permissionDenied = true;
}

async function findBundleFiles(
  dir: string,
  metrics: AppSizeMetrics
): Promise<void> {
  const bundlePatterns = [
    { pattern: /\.(bundle|jsbundle)$/i, type: "bundle" as const },
    { pattern: /\.js$/i, type: "js" as const },
    { pattern: /\.hbc$/i, type: "hbc" as const },
    { pattern: /index\.(android|ios)/i, type: "bundle" as const },
    { pattern: /main\.(jsbundle|bundle)/i, type: "bundle" as const },
    { pattern: /(js_receiver|bridge|loader)\.js$/i, type: "loader" as const },
    // Add more specific patterns for React Native bundles
    { pattern: /assets\/index\.android\.bundle$/i, type: "bundle" as const },
    { pattern: /assets\/index\.android\.js$/i, type: "bundle" as const },
    { pattern: /assets\/index\.android$/i, type: "bundle" as const },
  ];

  const MAGIC_NUMBERS = {
    HERMES_MAGIC: new Uint8Array([0xc6, 0x1f, 0xbc, 0x03, 0x2b]),
    GZIP_MAGIC: new Uint8Array([0x1f, 0x8b]),
  };

  async function checkFileType(path: string): Promise<{
    type: BundleInfo["type"];
    isEncrypted: boolean;
  }> {
    try {
      const file = await Deno.open(path);
      const buffer = new Uint8Array(8);
      await file.read(buffer);
      file.close();

      // Check for known magic numbers
      if (
        buffer.slice(0, 5).every((b, i) => b === MAGIC_NUMBERS.HERMES_MAGIC[i])
      ) {
        return { type: "hbc", isEncrypted: false };
      }
      if (
        buffer.slice(0, 2).every((b, i) => b === MAGIC_NUMBERS.GZIP_MAGIC[i])
      ) {
        return { type: "bundle", isEncrypted: false };
      }

      // Check for common JS patterns
      const content = await Deno.readTextFile(path);
      if (content.includes("__d(function")) {
        return { type: "bundle", isEncrypted: false };
      }
      if (
        content.includes("handleEvent") &&
        content.includes("window.addEventListener")
      ) {
        return { type: "loader", isEncrypted: false };
      }

      // Check for potential encryption
      const entropy = calculateEntropy(buffer);
      const isEncrypted = entropy > 7.5; // High entropy suggests encryption

      return { type: "unknown", isEncrypted };
    } catch {
      return { type: "unknown", isEncrypted: false };
    }
  }

  function calculateEntropy(buffer: Uint8Array): number {
    const freq = new Array(256).fill(0);
    buffer.forEach((byte) => freq[byte]++);
    return freq.reduce((entropy, count) => {
      if (count === 0) return entropy;
      const p = count / buffer.length;
      return entropy - p * Math.log2(p);
    }, 0);
  }

  // Check for development build indicators
  const devIndicators = [
    /dev\.properties$/i,
    /dev\.settings$/i,
    /dev\.config$/i,
    /development\.properties$/i,
    /development\.settings$/i,
    /development\.config$/i,
  ];

  try {
    // First check if this is a development build
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile &&
        devIndicators.some((pattern) => pattern.test(entry.name))
      ) {
        metrics.isDevelopmentBuild = true;
        metrics.bundleLoadingMechanism = {
          type: "development",
          loaderFiles: [],
          encryptedFiles: [],
        };
        return; // Skip further bundle search for development builds
      }
    }

    // If not a development build, proceed with normal bundle search
    if (!metrics.bundleLoadingMechanism) {
      metrics.bundleLoadingMechanism = {
        type: "unknown",
        loaderFiles: [],
        encryptedFiles: [],
      };
    }

    // Check common bundle locations
    const bundleLocations = [
      `${dir}/assets`,
      `${dir}/assets/assets`,
      `${dir}/assets/index.android.bundle`,
      `${dir}/assets/index.android.js`,
      `${dir}/assets/main.jsbundle`,
      dir,
    ];

    for (const location of bundleLocations) {
      try {
        const stat = await Deno.stat(location);

        if (stat.isFile) {
          // If it's a file, check if it's a bundle
          const matchedPattern = bundlePatterns.find(({ pattern }) =>
            pattern.test(location)
          );

          if (matchedPattern) {
            const { type, isEncrypted } = await checkFileType(location);

            if (!metrics.bundleFiles) metrics.bundleFiles = {};

            const name = location.split("/").pop() || "";
            metrics.bundleFiles[name] = {
              size: stat.size,
              path: location,
              type: type || matchedPattern.type,
              isEncrypted,
              isLoader: type === "loader" || matchedPattern.type === "loader",
            };

            metrics.bundleSize = (metrics.bundleSize || 0) + stat.size;

            if (isEncrypted) {
              metrics.bundleLoadingMechanism.type = "encrypted";
              metrics.bundleLoadingMechanism.encryptedFiles?.push(name);
            }
            if (type === "loader" || matchedPattern.type === "loader") {
              metrics.bundleLoadingMechanism.type = "custom";
              metrics.bundleLoadingMechanism.loaderFiles?.push(name);
            }
          }
        } else if (stat.isDirectory) {
          // If it's a directory, scan for bundle files
          for await (const entry of Deno.readDir(location)) {
            if (entry.isFile) {
              const path = `${location}/${entry.name}`;
              const matchedPattern = bundlePatterns.find(({ pattern }) =>
                pattern.test(entry.name)
              );

              if (matchedPattern) {
                const fileInfo = await Deno.stat(path);
                const { type, isEncrypted } = await checkFileType(path);

                if (!metrics.bundleFiles) metrics.bundleFiles = {};

                metrics.bundleFiles[entry.name] = {
                  size: fileInfo.size,
                  path,
                  type: type || matchedPattern.type,
                  isEncrypted,
                  isLoader:
                    type === "loader" || matchedPattern.type === "loader",
                };

                metrics.bundleSize = (metrics.bundleSize || 0) + fileInfo.size;

                if (isEncrypted) {
                  metrics.bundleLoadingMechanism.type = "encrypted";
                  metrics.bundleLoadingMechanism.encryptedFiles?.push(
                    entry.name
                  );
                }
                if (type === "loader" || matchedPattern.type === "loader") {
                  metrics.bundleLoadingMechanism.type = "custom";
                  metrics.bundleLoadingMechanism.loaderFiles?.push(entry.name);
                }
              }
            }
          }
        }
      } catch (error) {
        // Ignore errors for locations that don't exist
      }
    }

    // Determine if bundles are split
    if (metrics.bundleFiles && Object.keys(metrics.bundleFiles).length > 1) {
      const bundleCount = Object.values(metrics.bundleFiles).filter(
        (info) => info.type === "bundle" || info.type === "hbc"
      ).length;
      if (bundleCount > 1) {
        metrics.bundleLoadingMechanism.type = "split";
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Permission denied")) {
      metrics.permissionDenied = true;
    }
  }
}

async function analyzeNativeLibraries(
  extractDir: string,
  metrics: AppSizeMetrics
): Promise<void> {
  const libDir = `${extractDir}/lib`;
  const libPatterns = {
    hermes: [/^libhermes/, /hermes/],
    react: [/^libreact/, /react/],
  };

  try {
    const totalLibSize = await calculateDirSize(libDir);
    if (totalLibSize === 0) return;

    metrics.nativeLibrariesSize = totalLibSize;
    metrics.architectureBreakdown = {};
    metrics.componentsBreakdown = { "Native Libraries": totalLibSize };

    // Initialize Hermes runtime info
    metrics.hermesRuntime = {
      present: false,
      architectures: [],
      totalSize: 0,
    };

    let reactNativeSize = 0;
    const libraryInfo: Record<string, NativeLibInfo[]> = {};

    for await (const archEntry of Deno.readDir(libDir)) {
      if (!archEntry.isDirectory) continue;

      const archPath = `${libDir}/${archEntry.name}`;
      let archSize = 0;

      for await (const libEntry of Deno.readDir(archPath)) {
        if (!libEntry.isFile) continue;

        const libPath = `${archPath}/${libEntry.name}`;
        const libStat = await Deno.stat(libPath);
        archSize += libStat.size;

        // Categorize the library
        let libType: NativeLibInfo["type"] = "other";
        if (libPatterns.hermes.some((pattern) => pattern.test(libEntry.name))) {
          libType = "hermes";
          metrics.hermesRuntime.present = true;
          metrics.hermesRuntime.totalSize += libStat.size;
          if (!metrics.hermesRuntime.architectures.includes(archEntry.name)) {
            metrics.hermesRuntime.architectures.push(archEntry.name);
          }

          // Try to extract Hermes version
          if (
            libEntry.name === "libhermes.so" &&
            !metrics.hermesRuntime.version
          ) {
            try {
              const { stdout } = await runCommand("strings", [
                libPath,
                "|",
                "grep",
                "-i",
                "hermes version",
              ]);
              if (stdout) {
                const versionMatch = stdout.match(/version\s*[:\s]\s*(.+)/i);
                if (versionMatch?.[1]) {
                  metrics.hermesRuntime.version = versionMatch[1].trim();
                }
              }
            } catch {
              // Ignore version extraction errors
            }
          }
        } else if (
          libPatterns.react.some((pattern) => pattern.test(libEntry.name))
        ) {
          libType = "react";
          reactNativeSize += libStat.size;
        }

        if (!libraryInfo[archEntry.name]) {
          libraryInfo[archEntry.name] = [];
        }

        libraryInfo[archEntry.name].push({
          size: libStat.size,
          path: libPath,
          architecture: archEntry.name,
          type: libType,
        });
      }

      if (archSize > 0) {
        metrics.architectureBreakdown[archEntry.name] = archSize;
      }
    }

    // Update React Native libs size
    metrics.reactNativeLibsSize = reactNativeSize;

    // Add detailed breakdown to components
    if (metrics.hermesRuntime.totalSize > 0) {
      metrics.componentsBreakdown["Hermes Runtime"] =
        metrics.hermesRuntime.totalSize;
    }
    if (reactNativeSize > 0) {
      metrics.componentsBreakdown["React Native Libraries"] = reactNativeSize;
    }
    metrics.componentsBreakdown["Other Native Libraries"] =
      totalLibSize - (metrics.hermesRuntime.totalSize + reactNativeSize);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Permission denied")) {
      metrics.permissionDenied = true;
    }
  }
}

async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      const path = `${dirPath}/${entry.name}`;
      if (entry.isFile) {
        const info = await Deno.stat(path);
        totalSize += info.size;
      } else if (entry.isDirectory) {
        totalSize += await calculateDirSize(path);
      }
    }
  } catch (error) {
    console.error(
      `Error calculating directory size: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return totalSize;
}

function formatSize(size: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let formattedSize = size;
  let unitIndex = 0;

  while (formattedSize >= 1024 && unitIndex < units.length - 1) {
    formattedSize /= 1024;
    unitIndex++;
  }

  return `${formattedSize.toFixed(2)} ${units[unitIndex]}`;
}

async function writeReport(
  config: Config,
  metrics: AppSizeMetrics
): Promise<void> {
  const formatSection = (title: string, content: string) =>
    `\n${title}\n${"-".repeat(title.length)}\n${content}`;

  const sections: string[] = [
    `Android App Size Report (${metrics.timestamp})`,
    `Package: ${config.appPackage}`,
    `Build Type: ${config.buildType}`,
    "",
    `Download Size: ${formatSize(metrics.downloadSize)}`,
    metrics.installedAppSize > 0
      ? `Installed Size: ${formatSize(metrics.installedAppSize)}`
      : "Installed Size: Permission denied",
  ];

  if (metrics.isDevelopmentBuild) {
    sections.push(
      formatSection(
        "Development Build Info",
        "This is a development build. The JavaScript bundle is served from Metro bundler and not included in the APK."
      )
    );
  }

  if (metrics.bundleFiles) {
    const bundleSection = [
      "JavaScript Bundle Analysis:",
      ...Object.entries(metrics.bundleFiles).map(([filename, info]) =>
        [
          `  - ${filename}:`,
          `    Size: ${formatSize(info.size)}`,
          `    Type: ${info.type}`,
          info.isEncrypted ? "    Status: Encrypted" : "",
          info.isLoader ? "    Role: Bundle Loader" : "",
        ]
          .filter(Boolean)
          .join("\n")
      ),
    ].join("\n");
    sections.push(formatSection("Bundle Files", bundleSection));
  }

  if (metrics.bundleLoadingMechanism) {
    const loadingSection = [
      `Bundle Loading Type: ${metrics.bundleLoadingMechanism.type}`,
      metrics.bundleLoadingMechanism.loaderFiles?.length
        ? `Loader Files:\n  - ${metrics.bundleLoadingMechanism.loaderFiles.join(
            "\n  - "
          )}`
        : "",
      metrics.bundleLoadingMechanism.encryptedFiles?.length
        ? `Encrypted Files:\n  - ${metrics.bundleLoadingMechanism.encryptedFiles.join(
            "\n  - "
          )}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    sections.push(formatSection("Bundle Loading Mechanism", loadingSection));
  }

  if (metrics.hermesRuntime) {
    const hermesSection = [
      `Hermes Runtime: ${
        metrics.hermesRuntime.present ? "Present" : "Not Found"
      }`,
      metrics.hermesRuntime.version
        ? `Version: ${metrics.hermesRuntime.version}`
        : "",
      `Total Size: ${formatSize(metrics.hermesRuntime.totalSize)}`,
      `Architectures: ${metrics.hermesRuntime.architectures.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
    sections.push(formatSection("Hermes Runtime", hermesSection));
  }

  if (metrics.architectureBreakdown) {
    const archSection = [
      "Size by Architecture:",
      ...Object.entries(metrics.architectureBreakdown).map(
        ([arch, size]) => `  - ${arch}: ${formatSize(size)}`
      ),
    ].join("\n");
    sections.push(formatSection("Architecture Breakdown", archSection));
  }

  if (metrics.componentsBreakdown) {
    const componentSection = [
      "Size by Component:",
      ...Object.entries(metrics.componentsBreakdown).map(
        ([component, size]) => `  - ${component}: ${formatSize(size)}`
      ),
    ].join("\n");
    sections.push(formatSection("Component Breakdown", componentSection));
  }

  if (metrics.appPaths) {
    const pathsSection = [
      metrics.appPaths.dataDir
        ? `Data Directory: ${metrics.appPaths.dataDir}`
        : "",
      metrics.appPaths.codePath
        ? `Code Path: ${metrics.appPaths.codePath}`
        : "",
      metrics.appPaths.resourcePath
        ? `Resource Path: ${metrics.appPaths.resourcePath}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    sections.push(formatSection("App Paths", pathsSection));
  }

  // Write text report
  const textReport = sections.join("\n");
  await Deno.writeTextFile(
    `${config.outputDir}/app_size_report.txt`,
    textReport
  );

  // Write JSON report
  await Deno.writeTextFile(
    `${config.outputDir}/app_size_report.json`,
    JSON.stringify(metrics, null, 2)
  );

  if (config.verbose) {
    console.log(textReport);
  }
}

async function getAppSize(config: Config): Promise<AppSizeMetrics | null> {
  const isInstalled = await checkAppInstalled(config.appPackage);
  if (!isInstalled) {
    console.error(`App ${config.appPackage} is not installed on the device`);
    return null;
  }

  const metrics: AppSizeMetrics = {
    installedAppSize: 0,
    downloadSize: 0,
    timestamp: new Date().toISOString(),
    permissionDenied: false,
  };

  const { success, stdout } = await runCommand("adb", [
    "shell",
    "pm",
    "path",
    config.appPackage,
  ]);
  if (!success || !stdout) {
    console.error("Failed to get app path");
    return metrics;
  }

  const apkPaths = stdout
    .trim()
    .split("\n")
    .map((line) => line.replace("package:", "").trim())
    .filter((path) => path.length > 0);

  if (apkPaths.length === 0) {
    console.error("No APK paths found");
    return metrics;
  }

  let totalSize = 0;
  const mainApk = apkPaths[0];

  for (const path of apkPaths) {
    const sizeResult = await runCommand("adb", ["shell", "wc", "-c", path]);
    if (sizeResult.success) {
      const size = parseInt(sizeResult.stdout.trim().split(/\s+/)[0], 10);
      if (!isNaN(size)) totalSize += size;
    }
  }
  metrics.downloadSize = totalSize;

  const tempDir = await Deno.makeTempDir();
  try {
    const localApkPath = `${tempDir}/app.apk`;
    const pullResult = await runCommand("adb", ["pull", mainApk, localApkPath]);

    if (pullResult.success) {
      const extractDir = `${tempDir}/extracted`;
      await Deno.mkdir(extractDir, { recursive: true });
      const extractResult = await runCommand("unzip", [
        "-q",
        localApkPath,
        "-d",
        extractDir,
      ]);

      if (extractResult.success) {
        await findBundleFiles(extractDir, metrics);
        await analyzeNativeLibraries(extractDir, metrics);
      }
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }

  await getInstalledAppSize(config, metrics);
  return metrics;
}

async function checkAppInstalled(packageName: string): Promise<boolean> {
  const { success, stdout } = await runCommand("adb", [
    "shell",
    "pm",
    "list",
    "packages",
    packageName,
  ]);
  return success && stdout.includes(packageName);
}

function printUsage() {
  console.log(`
Usage: measure_app_size.ts [options]

Options:
  -p, --package     Android package name (default: ${DEFAULT_PACKAGE_NAME})
  -o, --output      Output directory for reports (default: ./app_size_reports)
  -v, --verbose     Enable verbose output
  --hermes         Search for Hermes-related files and metrics
  --deep-search    Enable deep search for bundles and loaders
  --analyze-loaders Enable analysis of custom bundle loaders
  --detect-encryption Enable detection of encrypted bundles
  --build-type     Build type to measure (development|production) (default: development)
  -h, --help       Show this help message
`);
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["package", "output", "build-type"],
    boolean: [
      "verbose",
      "hermes",
      "deep-search",
      "analyze-loaders",
      "detect-encryption",
      "help",
    ],
    alias: {
      p: "package",
      o: "output",
      v: "verbose",
      h: "help",
    },
  });

  if (args.help) {
    printUsage();
    return;
  }

  const config: Config = {
    appPackage: args.package || DEFAULT_PACKAGE_NAME,
    outputDir: args.output || "./app_size_reports",
    verbose: args.verbose || false,
    searchForHermes: args.hermes || true,
    deepSearch: args["deep-search"] || false,
    analyzeLoaders: args["analyze-loaders"] || false,
    detectEncryption: args["detect-encryption"] || false,
    buildType:
      (args["build-type"] as "development" | "production") || "development",
  };

  // Validate build type
  if (config.buildType !== "development" && config.buildType !== "production") {
    console.error(
      "Invalid build type. Must be either 'development' or 'production'"
    );
    Deno.exit(1);
  }

  try {
    await Deno.mkdir(config.outputDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error(
        `Error creating output directory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      Deno.exit(1);
    }
  }

  if (!(await checkDeviceConnected())) {
    console.error(
      "No Android device connected. Please connect a device and try again."
    );
    Deno.exit(1);
  }

  if (!(await checkAppInstalled(config.appPackage))) {
    console.error(`App ${config.appPackage} is not installed on the device.`);
    Deno.exit(1);
  }

  const metrics = await getAppSize(config);
  if (!metrics) {
    console.error("Failed to gather app size metrics.");
    Deno.exit(1);
  }

  // Set build type in metrics
  metrics.isDevelopmentBuild = config.buildType === "development";

  await writeReport(config, metrics);

  if (config.verbose) {
    console.log(`\nReports written to ${config.outputDir}/`);
  }
}

if (import.meta.main) {
  main();
}
