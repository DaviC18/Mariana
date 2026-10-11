/** biome-ignore-all lint/style/useFilenamingConvention: <> */

/**
 * Formats a date into a natural Portuguese string for slot offerings.
 * Example: "Terça-feira, 24 de Setembro às 10:00"
 */
export function formatSlotDate(date: Date): string {
	const dayFormatter = new Intl.DateTimeFormat("pt-BR", {
		day: "numeric",
		month: "long",
		weekday: "long",
	});

	const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
		hour: "2-digit",
		minute: "2-digit",
	});

	const dayPart = dayFormatter.format(date);
	const timePart = timeFormatter.format(date);

	// Capitalize first letter of the weekday
	const formattedDay = dayPart.charAt(0).toUpperCase() + dayPart.slice(1);

	return `${formattedDay} às ${timePart}`;
}
