/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/streamdown/dist/**/*.js",
    "./node_modules/@streamdown/code/dist/**/*.js",
    "./node_modules/@streamdown/mermaid/dist/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        border: "#e2e8f0",
        input: "#e2e8f0",
        ring: "#4f46e5",
        background: "#ffffff",
        foreground: "#0f172a",
        primary: {
          DEFAULT: "#0f172a",
          foreground: "#ffffff",
        },
        muted: {
          DEFAULT: "#f1f5f9",
          foreground: "#475569",
        },
        card: {
          DEFAULT: "#ffffff",
          foreground: "#0f172a",
        },
        sidebar: {
          DEFAULT: "#f8fafc",
          foreground: "#0f172a",
        },
      },
      borderRadius: {
        lg: "0.625rem",
        md: "calc(0.625rem - 2px)",
        sm: "calc(0.625rem - 4px)",
      },
    },
  },
  plugins: [],
};
