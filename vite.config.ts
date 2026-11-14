import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // PORT may come from the environment or from a .env file (see .env.example).
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const port = env.PORT ? Number(env.PORT) : undefined;
  return {
    base: "./",
    server: { port },
    preview: { port },
  };
});
