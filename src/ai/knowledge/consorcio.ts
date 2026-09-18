import type { KnowledgeItem } from "./types";

const SOURCE = "Ademicon - conceitos de consórcio aprovados";
const VERSION = "2026-09-16";

export const CONSORTIUM_KNOWLEDGE: KnowledgeItem[] = [
	{
		category: "general",
		clientAllowed: true,
		content:
			"O consórcio reúne pessoas interessadas em adquirir bens ou serviços e organiza contribuições mensais dentro de um grupo. As assembleias ocorrem periodicamente e podem resultar em contemplações por sorteio ou por lance, conforme as regras do grupo e do contrato.",
		id: "consorcio-como-funciona",
		keywords: [
			"consorcio",
			"grupo",
			"contribuicoes",
			"assembleias",
			"sorteio",
			"lance",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "general",
		clientAllowed: true,
		content:
			"A carta de crédito representa o crédito disponível ao consorciado contemplado para utilização na aquisição do bem ou serviço permitido pelo plano.",
		id: "consorcio-carta-de-credito",
		keywords: ["carta", "credito", "bem", "servico", "plano"],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "contractual",
		clientAllowed: true,
		content:
			"A contemplação pode ocorrer por sorteio ou por lance. A Ademicon informa em seus canais oficiais que não comercializa cotas com data certa para contemplação ou cotas já contempladas. Não é possível prever o momento exato da contemplação.",
		id: "consorcio-contemplacao-sem-previsao",
		keywords: ["contemplacao", "sorteio", "lance", "data", "prazo", "prever"],
		source: SOURCE,
		version: VERSION,
	},
	{
		accessLevel: 2,
		category: "general",
		clientAllowed: true,
		content:
			"As assembleias podem utilizar critérios de sorteio definidos pelas regras do grupo. A Ademicon informa que utiliza os resultados da Loteria Federal como referência para seus sorteios.",
		id: "consorcio-sorteio-loteria-federal",
		keywords: ["assembleia", "sorteio", "loteria federal", "grupo"],
		source: SOURCE,
		version: VERSION,
	},
	{
		accessLevel: 2,
		category: "general",
		clientAllowed: true,
		content:
			"O lance é uma forma de participação na contemplação mediante oferta de um valor ou quantidade de parcelas, conforme a modalidade e as regras do grupo. Existem diferentes modalidades de lance.",
		id: "consorcio-lance-conceito",
		keywords: ["lance", "participacao", "valor", "parcelas", "modalidade"],
		source: SOURCE,
		version: VERSION,
	},
	{
		accessLevel: 2,
		category: "contractual",
		clientAllowed: true,
		content:
			"A disponibilidade, percentual, regra e critério aplicável ao lance dependem do grupo, produto e condições contratadas. Um determinado lance não garante contemplação.",
		id: "consorcio-lance-depende-do-grupo",
		keywords: ["lance", "percentual", "regra", "criterio", "grupo", "garante"],
		source: SOURCE,
		version: VERSION,
	},
	{
		accessLevel: 2,
		category: "contractual",
		clientAllowed: true,
		content:
			"A contemplação não significa liberação imediata do crédito. A utilização do crédito está sujeita aos procedimentos e requisitos aplicáveis ao grupo e ao contrato. Questões específicas sobre documentação, condições e liberação do crédito devem ser direcionadas a um consultor.",
		id: "consorcio-credito-procedimentos",
		keywords: [
			"contemplacao",
			"liberacao",
			"credito",
			"documentacao",
			"condicoes",
			"consultor",
		],
		source: SOURCE,
		version: VERSION,
	},
	{
		category: "internal",
		clientAllowed: false,
		content:
			"Informações sobre sorteios, lances, médias ou exemplos nunca devem ser transformadas em garantia ou promessa de contemplação.",
		id: "consorcio-regra-interna-sem-promessa",
		keywords: [
			"sorteios",
			"lances",
			"medias",
			"exemplos",
			"promessa",
			"garantia",
		],
		source: SOURCE,
		version: VERSION,
	},
];
