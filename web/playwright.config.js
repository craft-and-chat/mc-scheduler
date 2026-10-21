import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5173', ...devices['Pixel 7'], viewport: { width: 360, height: 800 } },
  webServer: { command: 'npx vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60000 },
});
