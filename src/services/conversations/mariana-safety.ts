/** biome-ignore-all lint/style/useFilenamingConvention: <> */

const FORBIDDEN_PATTERNS = [
	/\b(?:voce|o cliente) sera contemplado\b/i,
	/\b(?:voce|o cliente) vai ser contemplado\b/i,
	/\b(?:garanto|garantimos|esta garantido|fica garantido)\b.{0,40}\b(?:contemplacao|aprovacao|liberacao|retorno|lucro)\b/i,
	/\b(?:lance|percentual de lance)\s+(?:de\s+)?\d+(?:[,.]\d+)?\s*%?\s+(?:sera|vai|e|é)\s+(?:suficiente|garantido|certo)\b/i,
	/\b(?:recomendo|indico|sugiro)\b.{0,60}\b(?:lance|grupo|carta|operacao|estrategia)\b/i,
	/\b(?:carta|grupo|lance|estrategia)\b.{0,30}\b(?:ideal|melhor|certo|adequado)\b/i,
	/\b(?:voce|o cliente) (?:tera|vai ter|terá)\b.{0,40}\b(?:lucro|retorno financeiro|rentabilidade|aprovacao|liberacao)\b/i,
	/\b(?:sua contemplacao|a contemplacao) esta garantida\b/i,
	/em ate \d+ meses\b/i,
	/ultimas cotas/i,
	/vagas limitadas/i,
	/\bgarantia de contemplacao\b/i,
	/\btera aprovacao garantida\b/i,
	/\bresultado financeiro garantido\b/i,
];
const NEGATION_PATTERN = /\b(?:nao|nunca|sem)\b/;

export function isGuardrailHit(message: string): boolean {
	const normalized = message
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

	return FORBIDDEN_PATTERNS.some((pattern) => {
		for (const match of normalized.matchAll(new RegExp(pattern.source, "gi"))) {
			const prefix = normalized.slice(
				Math.max(0, (match.index ?? 0) - 35),
				match.index
			);
			if (!NEGATION_PATTERN.test(prefix)) {
				return true;
			}
		}

		return false;
	});
}

export function assertSafeMarianaReply(message: string): void {
	if (isGuardrailHit(message)) {
		throw new Error("Mariana reply violates the safety guardrails");
	}
}
