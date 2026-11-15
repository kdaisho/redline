import { defineConfig } from 'vite';

// Two pages: the game and its soundtrack player (#31).
export default defineConfig({
  // Relative asset URLs, so the build works from any path — the domain root or a
  // subpath such as GitHub Pages' /redline/ (#35). Both pages sit side by side.
  base: './',
  build: {
    rollupOptions: {
      input: { main: 'index.html', soundtrack: 'soundtrack.html' },
    },
  },
});
