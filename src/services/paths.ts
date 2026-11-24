// Artifact keys become paths inside the downloaded zip, and they originate from
// model output — normalise them so nothing can escape the archive root.

export function safeArtifactPath(input: string): string | null {
  const parts = String(input)
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === ".." || /[\0<>:"|?*]/.test(p))) return null;
  const path = parts.join("/");
  return path.length <= 200 ? path : null;
}
