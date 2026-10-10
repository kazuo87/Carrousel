import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePubmedXml } from "../src/pubmed.js";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_XML = fs.readFileSync(path.join(here, "fixtures", "efetch-sample.xml"), "utf8");
export const records = () => parsePubmedXml(FIXTURE_XML);
export const recordByPmid = (pmid) => records().find((r) => r.pmid === pmid);

export async function tmpDir(prefix = "carrousel-test-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, images: path.join(dir, "images"), cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

export const emptySeen = () => ({ pmids: new Set(), dois: new Set(), titles: new Set() });

export const NOW = Date.parse("2026-10-03T12:00:00Z");
