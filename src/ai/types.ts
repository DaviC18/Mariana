/** biome-ignore-all lint/style/useFilenamingConvention: <> */

export interface MarianaLeadContext {
	consortiumType: string;
	id: string;
	name: string;
	objective: string;
	phone: string;
	status: string;
}

export interface MarianaMessageContext {
	content: string;
	createdAt: Date;
	externalId?: string | null;
	role: "user" | "assistant" | "system";
}

export interface GenerateMarianaResponseParams {
	currentMessage: string;
	lead: MarianaLeadContext;
	messages: MarianaMessageContext[];
}
