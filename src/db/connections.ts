/** biome-ignore-all assist/source/organizeImports: <> */
import { relations } from "./schema/relations";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";

const sql = postgres(env.DATABASE_URL);

export const db = drizzle({ client: sql, relations });
