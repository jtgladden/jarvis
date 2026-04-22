import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function readEnvValueFromFile(
  filePath: string,
  key: string
): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const currentKey = trimmed.slice(0, separatorIndex).trim();
    if (currentKey !== key) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    return value;
  }

  return undefined;
}

function readRootEnvValue(key: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env"),
  ];

  for (const candidate of candidates) {
    const value = readEnvValueFromFile(candidate, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function GET() {
  const cesiumIonToken =
    process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ||
    process.env.CESIUM_ION_TOKEN ||
    readRootEnvValue("NEXT_PUBLIC_CESIUM_ION_TOKEN") ||
    readRootEnvValue("CESIUM_ION_TOKEN") ||
    "";
  const cesiumTerrainUrl =
    process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL ||
    process.env.CESIUM_TERRAIN_URL ||
    readRootEnvValue("NEXT_PUBLIC_CESIUM_TERRAIN_URL") ||
    readRootEnvValue("CESIUM_TERRAIN_URL") ||
    "";

  return NextResponse.json(
    {
      cesiumIonToken,
      cesiumTerrainUrl,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
