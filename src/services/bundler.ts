// Stage 4: deliverable packaging (spec §3). Streams a zip; never buffers it whole.

import { ZipArchive } from "archiver";
import type { Readable } from "node:stream";
import { safeArtifactPath } from "./paths.js";

export function createArtifactZip(artifacts: Record<string, string>, rootDir?: string): Readable {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  for (const [key, content] of Object.entries(artifacts)) {
    const path = safeArtifactPath(key);
    if (!path) continue;
    archive.append(content, { name: rootDir ? `${rootDir}/${path}` : path });
  }
  void archive.finalize();
  return archive;
}
