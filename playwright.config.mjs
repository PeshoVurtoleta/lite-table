import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./test-browser",
    timeout: 30000,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:5174",
        actionTimeout: 5000,
        navigationTimeout: 10000,
        trace: "off",
    },
    projects: [
        {
            name: "chromium",
            use: {
                browserName: "chromium",
                launchOptions: {
                    executablePath: process.env.CHROMIUM_BIN || undefined,
                    args: ["--no-sandbox"],
                },
            },
        },
    ],
    webServer: {
        command: "node demo/serve.mjs",
        url: "http://127.0.0.1:5174/demo/index.html",
        reuseExistingServer: true,
        timeout: 5000,
        env: { PORT: "5174" },
    },
});
