import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "#/lib/theme";
import { ThemeSlider } from "./ThemeSlider";

function installMatchMedia(matches = false) {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: vi.fn().mockImplementation(() => ({
			matches,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	});
}

describe("ThemeSlider", () => {
	beforeEach(() => {
		window.localStorage.clear();
		document.documentElement.dataset.theme = "light";
		document.documentElement.dataset.themePreference = "system";
		installMatchMedia(false);
	});

	afterEach(() => {
		cleanup();
		delete (
			document as unknown as {
				startViewTransition?: unknown;
			}
		).startViewTransition;
		vi.restoreAllMocks();
	});

	it("cycles theme states and persists the choice", async () => {
		render(
			<ThemeProvider>
				<ThemeSlider />
			</ThemeProvider>,
		);

		const themeButton = await screen.findByRole("button", {
			name: "Theme: System default. Switch to Light theme.",
		});
		await waitFor(() => {
			expect(themeButton).toBeEnabled();
		});
		fireEvent.click(themeButton);

		await waitFor(() => {
			expect(document.documentElement.dataset.theme).toBe("light");
		});
		expect(document.documentElement.dataset.themePreference).toBe("light");
		expect(window.localStorage.getItem("neo-archive-theme")).toBe("light");

		fireEvent.click(
			screen.getByRole("button", {
				name: "Theme: Light theme. Switch to Dark theme.",
			}),
		);

		await waitFor(() => {
			expect(document.documentElement.dataset.theme).toBe("dark");
		});
		expect(document.documentElement.dataset.themePreference).toBe("dark");
		expect(window.localStorage.getItem("neo-archive-theme")).toBe("dark");
	});

	it("uses one button instead of a three-way selector", async () => {
		render(
			<ThemeProvider>
				<ThemeSlider />
			</ThemeProvider>,
		);

		const themeButton = await screen.findByRole("button", {
			name: "Theme: System default. Switch to Light theme.",
		});
		await waitFor(() => {
			expect(themeButton).toBeEnabled();
		});

		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Light theme" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Dark theme" })).toBeNull();
	});
});
