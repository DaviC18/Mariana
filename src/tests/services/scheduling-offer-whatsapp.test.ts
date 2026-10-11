import assert from "node:assert/strict";
import test from "node:test";

import type { schedulingSlots } from "../../db/schema";
import { buildWhatsAppSchedulingOffer } from "../../services/calendar/scheduling-offer-service";

const BUTTON_TITLE = /09\/10 às 10:00/;

test("a oferta persistida gera botões que referenciam os slots reais", () => {
	const slots = [
		{
			id: "11111111-1111-4111-8111-111111111111",
			startAt: new Date("2026-10-09T13:00:00.000Z"),
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			startAt: new Date("2026-10-09T14:00:00.000Z"),
		},
	] as (typeof schedulingSlots.$inferSelect)[];

	const offer = buildWhatsAppSchedulingOffer(slots);

	assert.equal(offer.buttons.length, 2);
	assert.deepEqual(
		offer.buttons.map((button) => button.id),
		slots.map((slot) => slot.id)
	);
	assert.match(offer.buttons[0]?.title ?? "", BUTTON_TITLE);
});
