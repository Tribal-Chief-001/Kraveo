/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        stitch: {
          primary: '#00450d',
          'primary-container': '#1b5e20',
          'primary-fixed-dim': '#91d78a',
          secondary: '#705d00',
          'secondary-container': '#fdd400',
          'secondary-fixed': '#ffe170',
          dark: '#1b1c1c',
          card: '#151c2c',
          surface: '#fcf9f8',
          border: '#242f46',
          error: '#ba1a1a',
          'error-container': '#ffdad6',
        }
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
