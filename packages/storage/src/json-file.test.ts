import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "./json-file.js";

const tmpDirs: string[] = [];

describe("json-file", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes through a temp file and keeps the latest valid backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-json-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "state.json");

    await writeJsonFile(filePath, [{ id: "first" }]);
    await writeJsonFile(filePath, [{ id: "second" }]);

    await expect(readJsonFile(filePath, [])).resolves.toEqual([{ id: "second" }]);
    await expect(readJsonFile(`${filePath}.bak`, [])).resolves.toEqual([{ id: "first" }]);
    await expect(readFile(filePath, "utf8")).resolves.toContain("\n");
  });

  it("recovers from a corrupt primary file using the backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-json-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "state.json");

    await writeJsonFile(filePath, [{ id: "stable" }]);
    await writeJsonFile(`${filePath}.bak`, [{ id: "backup" }]);
    await writeFile(filePath, "[");

    await expect(readJsonFile(filePath, [])).resolves.toEqual([{ id: "backup" }]);
  });

  it("falls back instead of throwing when corrupt primary has no backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-json-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "state.json");

    await writeFile(filePath, "[");

    await expect(readJsonFile(filePath, [{ id: "fallback" }])).resolves.toEqual([{ id: "fallback" }]);
  });
});
