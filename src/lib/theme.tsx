import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type ThemeValue = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "neo-archive-theme";

interface ThemeContextValue {
	isReady: boolean;
	theme: ThemeValue;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: ThemeValue) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return "light";
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function resolveTheme(theme: ThemeValue): ResolvedTheme {
	return theme === "system" ? getSystemTheme() : theme;
}

function applyThemeToDocument(theme: ThemeValue) {
	if (typeof document === "undefined") return;

	const resolvedTheme = resolveTheme(theme);
	document.documentElement.dataset.themePreference = theme;
	document.documentElement.dataset.theme = resolvedTheme;
	document.documentElement.style.colorScheme = resolvedTheme;
}

function readInitialTheme(): ThemeValue {
	if (typeof document !== "undefined") {
		const value = document.documentElement.dataset.themePreference;
		if (value === "light" || value === "dark" || value === "system") {
			return value;
		}
	}

	if (typeof window !== "undefined") {
		const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") {
			return stored;
		}
	}

	return "system";
}

export const themeScript = `
(() => {
  const storageKey = "${THEME_STORAGE_KEY}";
  const root = document.documentElement;
  const stored = window.localStorage.getItem(storageKey);
  const preference =
    stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  root.dataset.themePreference = preference;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
})();
`;

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<ThemeValue>("system");
	const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
	const [isReady, setIsReady] = useState(false);

	useEffect(() => {
		const initialTheme = readInitialTheme();
		setThemeState(initialTheme);
		setResolvedTheme(resolveTheme(initialTheme));
		applyThemeToDocument(initialTheme);
		setIsReady(true);
	}, []);

	useEffect(() => {
		if (!isReady) {
			return;
		}

		applyThemeToDocument(theme);
		setResolvedTheme(resolveTheme(theme));
		window.localStorage.setItem(THEME_STORAGE_KEY, theme);

		if (theme !== "system" || typeof window.matchMedia !== "function") {
			return;
		}

		const media = window.matchMedia(
			"(prefers-color-scheme: dark)",
		) as unknown as {
			matches: boolean;
			addEventListener?: (type: "change", listener: () => void) => void;
			removeEventListener?: (type: "change", listener: () => void) => void;
			addListener?: (listener: () => void) => void;
			removeListener?: (listener: () => void) => void;
		};
		const onChange = () => {
			const nextResolvedTheme = media.matches ? "dark" : "light";
			setResolvedTheme(nextResolvedTheme);
			document.documentElement.dataset.theme = nextResolvedTheme;
			document.documentElement.style.colorScheme = nextResolvedTheme;
		};

		if (typeof media.addEventListener === "function") {
			media.addEventListener("change", onChange);
		} else {
			media.addListener?.(onChange);
		}
		return () => {
			if (typeof media.removeEventListener === "function") {
				media.removeEventListener("change", onChange);
			} else {
				media.removeListener?.(onChange);
			}
		};
	}, [isReady, theme]);

	const value = useMemo<ThemeContextValue>(
		() => ({
			isReady,
			theme,
			resolvedTheme,
			setTheme: setThemeState,
		}),
		[isReady, resolvedTheme, theme],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within ThemeProvider");
	}
	return context;
}
