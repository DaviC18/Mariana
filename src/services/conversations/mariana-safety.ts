/** biome-ignore-all lint/style/useFilenamingConvention: <> */

const FORBIDDEN_PATTERNS = [
	/você sera contemplado/i,
	/sua contemplacao esta garantida/i,
	/com certeza/i,
	/garantido/i,
	/aprovacao garantida/i,
	/lance suficiente/i,
	/em ate \d+ meses/i,
	/ultimas cotas/i,
	/vagas limitadas/i,
	/garantia de contemplacao/i,
	/tera aprovacao garantida/i,
	/resultado financeiro garantido/i,
];

export function isGuardrailHit(message: string): boolean {
	const normalized = message
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

	return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function assertSafeMarianaReply(message: string): void {
	if (isGuardrailHit(message)) {
		throw new Error("Mariana reply violates the safety guardrails");
	}
}
