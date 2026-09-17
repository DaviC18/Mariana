import type { KnowledgeItem } from "./types";

const SOURCE = "Ademicon - catálogo de produtos aprovado";
const VERSION = "2026-09-16";

export const PRODUCTS_KNOWLEDGE: KnowledgeItem[] = [
	{
		category: "general",
		clientAllowed: true,
		content:
			"A operação atendida pela Mariana trabalha com consórcios relacionados a veículos, imóveis, serviços, maquinário e veículos agrícolas, caminhões e carrocerias.",
		id: "produtos-segmentos-atendidos",
		keywords: [
			"produtos",
			"veiculos",
			"imoveis",
			"servicos",
			"maquinario",
			"caminhoes",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "commercial",
		clientAllowed: true,
		content:
			"O consórcio imobiliário pode ser utilizado para diferentes objetivos relacionados a imóveis, conforme as condições do plano contratado. Entre os exemplos estão compra de imóvel, construção, reforma e quitação de determinadas obrigações relacionadas a imóveis.",
		id: "produto-imobiliario-finalidades",
		keywords: [
			"consorcio",
			"imobiliario",
			"imovel",
			"compra",
			"construcao",
			"reforma",
			"quitacao",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "commercial",
		clientAllowed: true,
		content:
			"O consórcio de serviços pode atender diferentes finalidades, incluindo reformas, projetos arquitetônicos, energia solar, climatização, automação residencial, serviços odontológicos, viagens, intercâmbios, formaturas, casamentos e cursos.",
		id: "produto-servicos-finalidades",
		keywords: [
			"consorcio",
			"servicos",
			"reformas",
			"energia solar",
			"viagens",
			"cursos",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "commercial",
		clientAllowed: true,
		content:
			"O segmento de veículos pode envolver diferentes tipos de veículos, de acordo com o produto contratado. A operação da Mariana também atende interesses relacionados a caminhões, carrocerias, maquinário e veículos agrícolas.",
		id: "produto-veiculos-tipos",
		keywords: [
			"veiculos",
			"caminhoes",
			"carrocerias",
			"maquinario",
			"agricolas",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "internal",
		clientAllowed: false,
		content:
			"Exemplos de utilização não devem ser apresentados como condição personalizada; questões dependentes de contrato ou análise específica devem ser confirmadas por consultor.",
		id: "produto-regra-interna-personalizacao",
		keywords: [
			"condicao personalizada",
			"contrato",
			"analise especifica",
			"consultor",
		],
		source: SOURCE,
		version: VERSION,
	},
];
