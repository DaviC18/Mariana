export interface BusinessProfile {
	address?: string;
	city?: string;
	companyName?: string;
	website?: string;
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
	address: process.env.COMPANY_ADDRESS?.trim() || undefined,
	city: process.env.COMPANY_CITY?.trim() || undefined,
	companyName: process.env.COMPANY_NAME?.trim() || undefined,
	website: process.env.COMPANY_WEBSITE?.trim() || undefined,
};

export function resolveBusinessProfile(
	override?: BusinessProfile
): BusinessProfile {
	return {
		address:
			override?.address === undefined
				? DEFAULT_BUSINESS_PROFILE.address
				: override.address,
		city:
			override?.city === undefined
				? DEFAULT_BUSINESS_PROFILE.city
				: override.city,
		companyName:
			override?.companyName === undefined
				? DEFAULT_BUSINESS_PROFILE.companyName
				: override.companyName,
		website:
			override?.website === undefined
				? DEFAULT_BUSINESS_PROFILE.website
				: override.website,
	};
}
