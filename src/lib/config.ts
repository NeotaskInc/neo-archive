import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NeoArchivePaths {
	rootDir: string;
	dbPath: string;
	mediaOriginalsDir: string;
	mediaThumbsDir: string;
	configPath: string;
}

export type MentionsDataSource = "neo-archive" | "auto" | "xurl" | "bird";
export type ActionsTransport = "auto" | "bird" | "xurl";

export interface NeoArchiveConfig {
	accounts?: {
		default?: string;
	};
	mentions?: {
		dataSource?: MentionsDataSource;
		birdCommand?: string;
	};
	actions?: {
		transport?: ActionsTransport;
	};
	backup?: {
		repoPath?: string;
		remote?: string;
		autoSync?: boolean;
		staleAfterSeconds?: number;
	};
}

export function getDefaultAccountSelector() {
	const selector = getNeoArchiveConfig().accounts?.default?.trim();
	return selector || undefined;
}

let cachedPaths: NeoArchivePaths | undefined;
let cachedConfig: NeoArchiveConfig | undefined;

export function getNeoArchivePaths(): NeoArchivePaths {
	if (cachedPaths) {
		return cachedPaths;
	}

	const rootDir =
		process.env.NEO_ARCHIVE_HOME?.trim() ||
		path.join(os.homedir(), ".neo-archive");

	cachedPaths = {
		rootDir,
		dbPath: path.join(rootDir, "neo-archive.sqlite"),
		mediaOriginalsDir: path.join(rootDir, "media", "originals"),
		mediaThumbsDir: path.join(rootDir, "media", "thumbs"),
		configPath: path.join(rootDir, "config.json"),
	};

	return cachedPaths;
}

function parseConfigFile(configPath: string): NeoArchiveConfig {
	if (!existsSync(configPath)) {
		return {};
	}

	const raw = readFileSync(configPath, "utf8").trim();
	if (!raw) {
		return {};
	}

	const parsed = JSON.parse(raw) as NeoArchiveConfig;
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function getNeoArchiveConfig(): NeoArchiveConfig {
	if (cachedConfig) {
		return cachedConfig;
	}

	const configPath =
		process.env.NEO_ARCHIVE_CONFIG?.trim() || getNeoArchivePaths().configPath;
	cachedConfig = parseConfigFile(configPath);
	return cachedConfig;
}

function getConfigPath() {
	return (
		process.env.NEO_ARCHIVE_CONFIG?.trim() || getNeoArchivePaths().configPath
	);
}

export function writeNeoArchiveConfig(config: NeoArchiveConfig) {
	const configPath = getConfigPath();
	mkdirSync(path.dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	cachedConfig = config;
	return configPath;
}

export function setActionsTransport(transport: ActionsTransport) {
	const config = getNeoArchiveConfig();
	const nextConfig: NeoArchiveConfig = {
		...config,
		actions: {
			...config.actions,
			transport,
		},
	};
	const configPath = writeNeoArchiveConfig(nextConfig);
	return { configPath, transport };
}

export function resolveMentionsDataSource(
	requestedMode?: string,
): MentionsDataSource {
	if (
		requestedMode === "neo-archive" ||
		requestedMode === "auto" ||
		requestedMode === "xurl" ||
		requestedMode === "bird"
	) {
		return requestedMode;
	}

	const envMode = process.env.NEO_ARCHIVE_MENTIONS_DATA_SOURCE?.trim();
	if (
		envMode === "neo-archive" ||
		envMode === "auto" ||
		envMode === "xurl" ||
		envMode === "bird"
	) {
		return envMode;
	}

	const configMode = getNeoArchiveConfig().mentions?.dataSource;
	if (
		configMode === "neo-archive" ||
		configMode === "auto" ||
		configMode === "xurl" ||
		configMode === "bird"
	) {
		return configMode;
	}

	return "neo-archive";
}

export function resolveActionsTransport(
	requestedMode?: string,
): ActionsTransport {
	if (
		requestedMode === "auto" ||
		requestedMode === "bird" ||
		requestedMode === "xurl"
	) {
		return requestedMode;
	}

	const envMode = process.env.NEO_ARCHIVE_ACTIONS_TRANSPORT?.trim();
	if (envMode === "auto" || envMode === "bird" || envMode === "xurl") {
		return envMode;
	}

	const configMode = getNeoArchiveConfig().actions?.transport;
	if (configMode === "auto" || configMode === "bird" || configMode === "xurl") {
		return configMode;
	}

	return "auto";
}

function findCommandOnPath(command: string) {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}

	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}

	return undefined;
}

export function getBirdCommand() {
	const envCommand = process.env.NEO_ARCHIVE_BIRD_COMMAND?.trim();
	if (envCommand) {
		return envCommand;
	}

	const configuredCommand = getNeoArchiveConfig().mentions?.birdCommand?.trim();
	if (configuredCommand) {
		return configuredCommand;
	}

	const pathCommand = findCommandOnPath("bird");
	if (pathCommand) {
		return pathCommand;
	}

	return "bird";
}

export function ensureNeoArchiveDirs(): NeoArchivePaths {
	const paths = getNeoArchivePaths();

	mkdirSync(paths.rootDir, { recursive: true });
	mkdirSync(paths.mediaOriginalsDir, { recursive: true });
	mkdirSync(paths.mediaThumbsDir, { recursive: true });

	return paths;
}

export function resetNeoArchivePathsForTests() {
	cachedPaths = undefined;
	cachedConfig = undefined;
}
