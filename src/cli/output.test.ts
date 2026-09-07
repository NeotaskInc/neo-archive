// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI JSON output", () => {
	it("writes complete Unicode JSON larger than the pipe buffer", () => {
		const entry = new URL("./output.ts", import.meta.url).href;
		const result = spawnSync(
			process.execPath,
			[
				"--eval",
				`
			import(${JSON.stringify(entry)}).then(({ print }) => {
				void process.stdout;
				print({ id: "large-result", text: "café 東京 ".repeat(30000) }, true);
			});
		`,
			],
			{ encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			id: "large-result",
			text: "café 東京 ".repeat(30000),
		});
	});
});
