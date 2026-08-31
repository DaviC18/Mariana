/** biome-ignore-all lint/style/noExportedImports: <> */
import { appointments } from "./appointments";
import { consultants } from "./consultants";
import { conversations } from "./conversations";
import { leads } from "./leads";
import { messages } from "./messages";

export const schema = {
	appointments,
	consultants,
	conversations,
	leads,
	messages,
};
export { appointments, consultants, conversations, leads, messages };
