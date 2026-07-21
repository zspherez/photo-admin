import { sanitizedTestEnvironment } from "../lib/databaseWriteSafety.ts";

Object.assign(process.env, sanitizedTestEnvironment());
