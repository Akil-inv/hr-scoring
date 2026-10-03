import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        dark: { 900: '#0a0e1a', 800: '#111827', 700: '#1a2236', 600: '#1e293b', 500: '#334155' },
        accent: { DEFAULT: '#7c3aed', soft: '#7c3aed20', glow: '#7c3aed40', light: '#a78bfa' },
        success: { DEFAULT: '#10b981', soft: '#10b98120' },
        warning: { DEFAULT: '#f59e0b', soft: '#f59e0b20' },
        error: { DEFAULT: '#ef4444', soft: '#ef444420' },
        info: { DEFAULT: '#3b82f6', soft: '#3b82f620' },
      },
    },
  },
  plugins: [],
};
export default config;
