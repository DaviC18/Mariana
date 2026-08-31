import "dotenv/config";
import z from "zod";

const envSchema = z.object({
	DATABASE_URL: z
		.string()
		.min(1)
		.url()
		.refine((v) => v.startsWith("postgresql://"), {
			message: "DATABSE_URL It should start with postgresql://",
		}),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	PORT: z.coerce.number().default(3252),
});

export const env = envSchema.parse({
	DATABASE_URL: process.env.DATABASE_URL,
	NODE_ENV: process.env.NODE_ENV,
	PORT: process.env.PORT,
});
