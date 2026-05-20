import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure the Prisma query engine binary is bundled into Vercel serverless
  // functions. Our schema generates the client to a custom dir, and Next's
  // automatic tracing doesn't pick up the .so.node binary there by default.
  outputFileTracingIncludes: {
    "/**/*": ["./app/generated/prisma/**/*"],
  },
};

export default nextConfig;
