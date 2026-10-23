const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const NO_RELEASE = new Set(["docs", "test", "ci", "chore", "style"]);
const BUMPS = ["none", "patch", "minor", "major"];

function bumpFor(subject, body) {
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return "major";
  const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:/);
  if (!m) return "patch";
  if (m[3]) return "major";
  if (m[1] === "feat") return "minor";
  if (NO_RELEASE.has(m[1])) return "none";
  return "patch";
}

function latestTag() {
  return git("tag", "--merged", "HEAD", "--list", "v*")
    .split("\n")
    .map((t) => t.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/))
    .filter(Boolean)
    .map((m) => ({ tag: m[0], parts: m.slice(1).map(Number) }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
      }
      return 0;
    })[0];
}

const INSTALL_NOTES = `## Install

- **Windows:** run the \`.exe\`. The installer is unsigned, so if SmartScreen warns, click **More info → Run anyway**.
- **macOS:** open the \`.dmg\` and drag Streambert to Applications. The app is unsigned, so run \`xattr -cr /Applications/Streambert.app\` in Terminal once before opening it.
- You need your own TMDB API Read Access Token. Add it in Settings.
`;

const notesIdx = process.argv.indexOf("--notes");
const notesFile = notesIdx > -1 ? process.argv[notesIdx + 1] : null;

const base = latestTag();
let version;
let changes = [];

if (!base) {
  version = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ).version;
} else {
  const commits = git(
    "log",
    "--no-merges",
    "--format=%s%x1f%b%x1e",
    `${base.tag}..HEAD`,
  )
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ""] = c.split("\x1f");
      return { subject, bump: bumpFor(subject, body) };
    });

  const level = Math.max(0, ...commits.map((c) => BUMPS.indexOf(c.bump)));
  if (level === 0) {
    console.error("nothing to release");
    process.exit(0);
  }

  const [major, minor, patch] = base.parts;
  version =
    BUMPS[level] === "major"
      ? `${major + 1}.0.0`
      : BUMPS[level] === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  changes = commits.filter((c) => c.bump !== "none").map((c) => c.subject);
}

if (notesFile) {
  const list = changes.length
    ? `## Changes\n\n${changes.map((s) => `- ${s}`).join("\n")}\n\n`
    : "";
  fs.writeFileSync(notesFile, list + INSTALL_NOTES);
}
console.log(version);
