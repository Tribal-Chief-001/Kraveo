/** @type {import('tailwindcss').Config} */
// Kraveo design tokens. Hex values mirror packages/kraveo_ui (KraveoPalette / KStatus / KraveoTokens.driver).
// Keep in sync with src/lib/tokens.ts (used where a raw hex is required, e.g. Recharts).
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        kraveo: {
          // Forest green ramp (brand = g800)
          g50: '#EEF8EF',
          g100: '#D5EFD8',
          g200: '#A9DEB0',
          g300: '#74C880',
          g400: '#43AE55', // dark-surface brand (driver/admin)
          g500: '#23913A',
          g600: '#147A2C',
          g700: '#0C6423',
          g800: '#075219', // brand
          g900: '#063D14',
          g950: '#032309',
          brand: '#075219',
          brandSoft: '#12281A',
          // Electric yellow (accent, brand = 400)
          yellow: '#FFD600',
          y100: '#FFF6C2',
          y200: '#FFEC85',
          y300: '#FFE24D',
          y400: '#FFD600',
          y500: '#E6BE00',
          y700: '#8A6D00',
          // Cream (used only on the logo badge)
          cream: '#FAF7F0',
          // Night (driver / admin) neutrals
          night: '#080D09',
          surface: '#111812',
          surface2: '#1A241C',
          line: '#26322A',
          ink: '#F4F7F2',
          ink2: '#B4BFB6',
          ink3: '#7C897F',
          // Semantic
          success: '#23913A',
          warning: '#F59E0B',
          danger: '#E5484D',
          info: '#3B82F6',
          // One status language across every Kraveo surface
          status: {
            placed: '#F5A524',
            accepted: '#14B8A6',
            preparing: '#F97316',
            ready: '#84CC16',
            pickedUp: '#3B82F6',
            atGate: '#8B5CF6',
            delivered: '#16A34A',
            cancelled: '#E5484D',
          },
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque Variable"', '"Bricolage Grotesque"', '"Plus Jakarta Sans Variable"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'k-sm': '12px',
        'k-md': '16px',
        'k-lg': '20px',
        'k-xl': '24px',
        'k-2xl': '32px',
      },
      boxShadow: {
        // KShadow.soft / lift / glow. Dark surfaces need a stronger alpha than the light apps to stay visible.
        'k-soft': '0 1px 4px rgba(0,0,0,0.30), 0 12px 28px rgba(0,0,0,0.28)',
        'k-lift': '0 18px 40px rgba(0,0,0,0.42)',
        'k-glow': '0 10px 30px -4px rgba(67,174,85,0.45)',
        'k-glow-yellow': '0 10px 30px -4px rgba(255,214,0,0.35)',
      },
      transitionDuration: {
        fast: '140ms',
        base: '260ms',
        slow: '480ms',
      },
      transitionTimingFunction: {
        emphasized: 'cubic-bezier(0.215, 0.61, 0.355, 1)', // easeOutCubic
        spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)', // easeOutBack
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '150% 0' },
          '100%': { backgroundPosition: '-50% 0' },
        },
        'dot-pulse': {
          '0%': { boxShadow: '0 0 0 0 var(--dot, rgba(67,174,85,0.55))' },
          '70%': { boxShadow: '0 0 0 7px transparent' },
          '100%': { boxShadow: '0 0 0 0 transparent' },
        },
        'ring-out': {
          '0%': { transform: 'scale(0.6)', opacity: '0.7' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(12px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 480ms cubic-bezier(0.215, 0.61, 0.355, 1) both',
        'fade-in': 'fade-in 260ms ease-out both',
        'scale-in': 'scale-in 260ms cubic-bezier(0.175, 0.885, 0.32, 1.275) both',
        'slide-in-right': 'slide-in-right 320ms cubic-bezier(0.215, 0.61, 0.355, 1) both',
        'slide-in-left': 'slide-in-left 280ms cubic-bezier(0.215, 0.61, 0.355, 1) both',
        'slide-up': 'slide-up 320ms cubic-bezier(0.215, 0.61, 0.355, 1) both',
        shimmer: 'shimmer 1.4s linear infinite',
        'dot-pulse': 'dot-pulse 1.6s ease-out infinite',
        'ring-out': 'ring-out 2s ease-out infinite',
        'toast-in': 'toast-in 320ms cubic-bezier(0.175, 0.885, 0.32, 1.275) both',
      },
    },
  },
  plugins: [],
}
