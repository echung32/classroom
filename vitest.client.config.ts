import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // .tsx files use the automatic JSX runtime (matches tsconfig "jsx": "react-jsx").
  // vitest 4.x uses oxc by default; configure jsx there (esbuild option is ignored).
  oxc: { transform: { jsx: { runtime: "automatic" } } },
  resolve: {
    // Mirror the tsconfig "@/*" alias — plain vitest does not read tsconfig paths.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["test/client/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./test/client/setup.ts"],
  },
});
