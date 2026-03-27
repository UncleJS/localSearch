import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0a0a0a",
        surface: "#141414",
        border: "#2a2a2a",
        muted: "#6b7280",
        accent: "#3b82f6",
        "accent-hover": "#2563eb",
        foreground: "#f9fafb",
        "foreground-muted": "#9ca3af",
      },
    },
  },
  plugins: [],
};

export default config;
