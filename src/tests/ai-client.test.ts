import assert from "node:assert/strict";
import test from "node:test";

import { GEMINI_RETRY_OPTIONS } from "../ai/client";

test("cliente Gemini configura retry para erros HTTP transitórios", () => {
	assert.deepEqual(GEMINI_RETRY_OPTIONS, {
		attempts: 3,
		expBase: 2,
		httpStatusCodes: [408, 429, 500, 502, 503, 504],
		initialDelay: 0.5,
		jitter: 1,
		maxDelay: 4,
	});
});
