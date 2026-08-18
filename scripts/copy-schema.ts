import { cpSync, mkdirSync } from "node:fs";

// tsc emits .ts only. The migrations are .sql, so the build copies them itself;
// without this a clean `yarn build` produces a dist that cannot open the store.
mkdirSync("dist/store/schema", { recursive: true });
cpSync("src/store/schema", "dist/store/schema", { recursive: true });
