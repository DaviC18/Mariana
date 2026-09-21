/** biome-ignore-all lint/style/useConsistentTypeDefinitions: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/style/noParameterProperties: <> */
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { AvailabilityService } from "./availability";

export type Consultant = {
	id: string;
	name: string;
	calendarId: string;
};

export type ConsultantAvailableSlot = {
	consultant: Consultant;
	start: Date;
	end: Date;
};

export class ConsultantAvailabilityService {
	constructor(
		private readonly googleCalendarService = new GoogleCalendarService(),
		private readonly availabilityService = new AvailabilityService()
	) {}

	async getAvailableConsultants(
		consultants: Consultant[],
		timeMin: Date,
		timeMax: Date
	): Promise<ConsultantAvailableSlot[]> {
		if (timeMin >= timeMax) {
			throw new Error("timeMin deve ser anterior a timeMax.");
		}

		if (consultants.length === 0) {
			return [];
		}

		const consultantSlots = new Map<
			string,
			{
				consultant: Consultant;
				slots: { start: Date; end: Date }[];
			}
		>();

		for (const consultant of consultants) {
			const [calendarAvailability] =
				await this.googleCalendarService.getBusyPeriods(
					[consultant.calendarId],
					timeMin,
					timeMax
				);

			const slots = this.availabilityService.getAvailableSlots(
				timeMin,
				timeMax,
				calendarAvailability?.busy ?? []
			);

			consultantSlots.set(consultant.id, {
				consultant,
				slots,
			});
		}

		const result: ConsultantAvailableSlot[] = [];

		const uniqueSlotTimes = new Map<string, { start: Date; end: Date }>();

		for (const consultantData of consultantSlots.values()) {
			for (const slot of consultantData.slots) {
				const key = `${slot.start.toISOString()}_${slot.end.toISOString()}`;

				if (!uniqueSlotTimes.has(key)) {
					uniqueSlotTimes.set(key, slot);
				}
			}
		}

		for (const slot of uniqueSlotTimes.values()) {
			for (const consultant of consultants) {
				const consultantData = consultantSlots.get(consultant.id);

				if (!consultantData) {
					continue;
				}

				const isAvailable = consultantData.slots.some(
					(availableSlot) =>
						availableSlot.start.getTime() === slot.start.getTime() &&
						availableSlot.end.getTime() === slot.end.getTime()
				);

				if (isAvailable) {
					result.push({
						consultant,
						start: slot.start,
						end: slot.end,
					});

					break;
				}
			}
		}

		return result.sort((a, b) => a.start.getTime() - b.start.getTime());
	}
}
