import { defineConfig } from 'vite';

// Two pages: the game and its soundtrack player (#31).
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', soundtrack: 'soundtrack.html' },
    },
  },
});
