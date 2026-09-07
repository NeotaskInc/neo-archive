import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const built = spawnSync(
	"cargo",
	[
		"build",
		"--release",
		"--locked",
		"--jobs",
		process.env.NEO_ARCHIVE_BUILD_JOBS || "4",
	],
	{ cwd: path.join(root, "rust"), stdio: "inherit" },
);
if (built.error) throw built.error;
if (built.status !== 0)
	throw new Error(`Native build failed (${built.signal || built.status})`);
const filename =
	process.platform === "win32" ? "neoarchive-core.exe" : "neoarchive-core";
const directory = path.join(root, "dist", "native");
await mkdir(directory, { recursive: true });
await copyFile(
	path.join(root, "rust", "target", "release", filename),
	path.join(directory, filename),
);
await chmod(path.join(directory, filename), 0o755);
console.log(`Built native core for ${process.platform}/${process.arch}`);
