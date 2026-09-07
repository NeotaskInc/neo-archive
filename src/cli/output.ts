export function print(data: unknown, asJson: boolean) {
	if (asJson) {
		// Use the writable stream so large piped responses respect backpressure.
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	console.log(data);
}
