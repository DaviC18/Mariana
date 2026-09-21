/** biome-ignore-all lint/style/useConsistentTypeDefinitions: <> */
export type BusyPeriod = {
	start: string;
	end: string;
};

export type AvailableSlot = {
	start: Date;
	end: Date;
};

export class AvailabilityService {
	getAvailableSlots(
		timeMin: Date,
		timeMax: Date,
		busyPeriods: BusyPeriod[],
		slotDurationMinutes = 30
	): AvailableSlot[] {
		if (timeMin >= timeMax) {
			throw new Error("timeMin deve ser anterior a timeMax.");
		}

		if (slotDurationMinutes <= 0) {
			throw new Error("slotDurationMinutes deve ser maior que zero.");
		}

		const businessHours = this.getBusinessHours(timeMin, timeMax);

		const normalizedBusyPeriods = busyPeriods
			.map((period) => ({
				end: new Date(period.end),
				start: new Date(period.start),
			}))
			.filter((period) => period.start < period.end)
			.sort((a, b) => a.start.getTime() - b.start.getTime());

		const slotDurationMs = slotDurationMinutes * 60 * 1000;

		const availableSlots: AvailableSlot[] = [];

		for (const businessPeriod of businessHours) {
			for (
				let slotStart = new Date(businessPeriod.start);
				slotStart.getTime() + slotDurationMs <= businessPeriod.end.getTime();
				slotStart = new Date(slotStart.getTime() + slotDurationMs)
			) {
				const slotEnd = new Date(slotStart.getTime() + slotDurationMs);

				const hasConflict = normalizedBusyPeriods.some(
					(busyPeriod) =>
						busyPeriod.start < slotEnd && busyPeriod.end > slotStart
				);

				if (!hasConflict) {
					availableSlots.push({
						end: slotEnd,
						start: slotStart,
					});
				}
			}
		}

		return availableSlots;
	}

	getBusinessHours(timeMin: Date, timeMax: Date): AvailableSlot[] {
		if (timeMin >= timeMax) {
			throw new Error("timeMin deve ser anterior a timeMax.");
		}

		const businessHours: AvailableSlot[] = [];

		const currentDate = new Date(timeMin);

		while (currentDate < timeMax) {
			const dayOfWeek = currentDate.getDay();

			// Domingo = 0
			// Segunda = 1
			// ...
			// Sábado = 6
			const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

			if (isWeekday) {
				const start = new Date(currentDate);
				start.setHours(8, 0, 0, 0);

				const end = new Date(currentDate);
				end.setHours(18, 0, 0, 0);

				if (start < timeMax && end > timeMin) {
					businessHours.push({
						end: end > timeMax ? new Date(timeMax) : end,
						start: start < timeMin ? new Date(timeMin) : start,
					});
				}
			}

			currentDate.setDate(currentDate.getDate() + 1);
			currentDate.setHours(0, 0, 0, 0);
		}

		return businessHours;
	}
}
