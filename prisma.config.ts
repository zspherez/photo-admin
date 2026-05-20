// Loads .env for local dev. On Vercel, env vars come from the platform.
// Datasource is read from schema.prisma (so DIRECT_URL takes effect for migrations).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
