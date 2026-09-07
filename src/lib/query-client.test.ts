import { describe, expect, it, vi } from "vitest";
import { createNeoArchiveQueryClient, queryKeys } from "./query-client";

describe("query client", () => {
	it("deduplicates concurrent requests and retains fresh data", async () => {
		const queryClient = createNeoArchiveQueryClient();
		const queryFn = vi.fn(async () => ({ home: 42 }));

		const [first, second] = await Promise.all([
			queryClient.fetchQuery({ queryKey: queryKeys.status, queryFn }),
			queryClient.fetchQuery({ queryKey: queryKeys.status, queryFn }),
		]);
		const third = await queryClient.fetchQuery({
			queryKey: queryKeys.status,
			queryFn,
		});

		expect(first).toEqual(second);
		expect(third).toEqual({ home: 42 });
		expect(queryFn).toHaveBeenCalledOnce();
		queryClient.clear();
	});

	it("invalidates a query family without evicting unrelated data", async () => {
		const queryClient = createNeoArchiveQueryClient();
		queryClient.setQueryData([...queryKeys.timelines, { resource: "home" }], {
			pages: [],
		});
		queryClient.setQueryData(queryKeys.status, { home: 1 });

		await queryClient.invalidateQueries({ queryKey: queryKeys.timelines });

		expect(queryClient.getQueryData(queryKeys.status)).toEqual({ home: 1 });
		expect(
			queryClient.getQueryData([...queryKeys.timelines, { resource: "home" }]),
		).toEqual({ pages: [] });
		queryClient.clear();
	});
});
