import type { KnowledgeItem } from "./types";

const SOURCE = "Ademicon - informação institucional aprovada";
const VERSION = "2026-09-16";

export const ADEMICON_KNOWLEDGE: KnowledgeItem[] = [
	{
		category: "general",
		clientAllowed: true,
		content: "A Ademicon é uma administradora independente de consórcios.",
		id: "ademicon-administradora-independente",
		keywords: ["ademicon", "administradora", "consorcio"],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "general",
		clientAllowed: true,
		content:
			"Segundo as informações institucionais disponíveis nos canais oficiais da empresa, a Ademicon atua há 35 anos no mercado.",
		id: "ademicon-35-anos",
		keywords: ["ademicon", "anos", "mercado", "historia"],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "general",
		clientAllowed: true,
		content:
			"A empresa atua nos segmentos de imóveis, veículos e serviços e também administra consórcios de outras marcas por meio do modelo Consortium as a Service (CaaS).",
		id: "ademicon-segmentos-e-caas",
		keywords: ["segmentos", "imoveis", "veiculos", "servicos", "caas"],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "general",
		clientAllowed: true,
		content:
			"A Ademicon possui unidades no Brasil e também unidades no exterior.",
		id: "ademicon-unidades",
		keywords: ["unidades", "brasil", "exterior"],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "general",
		clientAllowed: true,
		content:
			"A Ademicon é uma empresa autorizada e fiscalizada pelo Banco Central do Brasil.",
		id: "ademicon-banco-central",
		keywords: ["autorizada", "fiscalizada", "banco central"],
		source: SOURCE,
		version: VERSION,
	},
];
