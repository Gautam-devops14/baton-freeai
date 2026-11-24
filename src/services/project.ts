// Project names: what the user calls a chat's project. Used for the .zip
// download (student-portal.zip with a student-portal/ folder inside) and exports.

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "with", "using", "in", "on", "me", "my", "please", "can", "you", "create", "build", "make", "write", "it", "that", "this", "is", "so", "we"]);

/** File-system friendly version of a name: "Student Portal!" -> "student-portal". */
export function slugify(name: string, max = 48): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, max).replace(/-$/, "") || "project";
}

/** A short default name from the first prompt: "Create a web app to score marks..." -> "web-app-score-marks". */
export function defaultProjectName(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  return slugify(words.slice(0, 4).join(" ") || "project");
}

/** Validate a user-entered project name (1-80 visible characters). */
export function cleanProjectName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const name = input.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 80 ? name : undefined;
}
