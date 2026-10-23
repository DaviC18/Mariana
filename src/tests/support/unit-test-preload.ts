// Carregado via `tsx --import` em `npm run test:unit`. Aponta `DATABASE_URL`
// para um endereço inalcançável antes de `src/env.ts` ler o `.env`: um teste
// "unitário" que tocar o banco falha em vez de alcançar o Neon.
import { FAKE_EXTERNAL_ENV } from "./fake-external-env";

Object.assign(process.env, FAKE_EXTERNAL_ENV, {
	DATABASE_URL: "postgresql://unit-tests-have-no-database@127.0.0.1:1/none",
	NODE_ENV: "test",
	RELIABILITY_WORKERS_ENABLED: "false",
});
